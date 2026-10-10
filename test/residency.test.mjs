import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { once } from 'node:events';
import { AgentManager } from '../dist/manager.js';
import { control } from '../dist/control.js';
import { waitUntil, processAlive, readJson, writeJson } from '../dist/storage.js';
import { tempDir } from './helpers/tmp.mjs';
const fixture = name => fileURLToPath(new URL(`./fixtures/${name}.mjs`, import.meta.url));
const pi = { command: process.execPath, args: [fixture('pi')] };
const role = { description: 'fixture only', instructions: 'test' };
function setup(t, flags = [], piFlags = []) {
  const cwd = tempDir('residency'), parent = path.join(cwd, 'parent.jsonl'), home = path.join(cwd, 'home');
  fs.mkdirSync(home); fs.writeFileSync(path.join(home, 'fixture-home'), ''); fs.writeFileSync(parent, '{}\n');
  const codex = { launch: { command: process.execPath, args: [fixture('codex'), ...flags] }, home };
  const m = new AgentManager(parent, { ...pi, args: [...pi.args, ...piFlags] }, codex);
  t.after(async () => { for (const s of m.list()) if (processAlive(s.workerPid)) await m.close(s.id); });
  return { cwd, parent, home, m, codex };
}
const idle = (m, id, status = 'completed') => waitUntil('resident run result', () => {
  const s = m.get(id); return s.phase === 'idle' && s.lastStatus === status ? s : undefined;
}, 8000);

for (const flag of ['--startup-dialog', '--startup-dialog-after-state', '--startup-dialog-with-state']) test(`worker preserves independent Pi startup UI ${flag}`, { timeout: 15000 }, async t => {
  const { cwd, m } = setup(t, [], [flag]);
  const first = await m.spawn('worker', role, cwd, 'after-dialog');
  assert.equal(first.phase, 'waiting');
  if (flag !== '--startup-dialog-after-state') assert.equal(first.accepted, false);
  const file = path.join(m.root, first.id, 'sessions', 'fake-session.json');
  if (flag !== '--startup-dialog-after-state') assert.equal(readJson(file)?.messages.filter(x => x.role === 'user').length ?? 0, 0);
  const q = first.questions[0]; assert(q);
  await m.reply(first.id, q.id, { confirmed: false }, { actor: 'parent', reason: 'Fixture configuration choice only' });
  const done = await idle(m, first.id);
  assert.equal(done.text, 'after-dialog'); assert.equal(done.runCount, 1); assert.equal(done.questions.length, 0);
  assert.equal(readJson(file).fixtureReplies.length, 1);
});

test('release unblocks the startup UI barrier without submitting the task', { timeout: 15000 }, async t => {
  const { cwd, m } = setup(t, [], ['--startup-dialog-with-state']);
  const first = await m.spawn('worker', role, cwd, 'must-not-start');
  assert.equal(first.phase, 'waiting'); assert.equal(first.accepted, false);
  const closed = await m.close(first.id); assert.equal(closed.phase, 'closed'); assert.equal(closed.lastStatus, 'stopped');
  const file = path.join(m.root, first.id, 'sessions', 'fake-session.json');
  assert.equal(readJson(file).messages.filter(x => x.role === 'user').length, 0);
  await waitUntil('released worker exits', () => !processAlive(first.workerPid));
});

test('ordinary Pi UI received during a task survives its normal completion', { timeout: 15000 }, async t => {
  const { cwd, m } = setup(t); const first = await m.spawn('worker', role, cwd, 'RUNTIME_UI');
  await waitUntil('native task ended', () => m.get(first.id).lastStatus);
  const pending = m.get(first.id); assert.equal(pending.phase, 'waiting'); assert.equal(pending.questions.length, 1);
  assert.equal(pending.lastStatus, 'completed');
  await m.reply(first.id, pending.questions[0].id, { confirmed: false });
  const done = await idle(m, first.id); assert.equal(done.text, 'original-result'); assert.equal(done.runCount, 1);
});

test('a prior logical question cannot answer a later run reusing the native tool-call id', { timeout: 15000 }, async t => {
  const { cwd, m } = setup(t); const first = await m.spawn('worker', role, cwd, 'ASK_PARENT');
  const old = await waitUntil('first question', () => m.get(first.id).questions[0]);
  await m.reply(first.id, old.id, { value: 'Unit' }); await idle(m, first.id);
  await m.send(first.id, 'ASK_PARENT');
  const current = await waitUntil('second question', () => m.get(first.id).questions[0]);
  assert.notEqual(old.id, current.id);
  await assert.rejects(m.reply(first.id, old.id, { value: 'Unit' }), /ended|exist|pending/);
  await m.reply(first.id, current.id, { value: 'Integration' }); assert.match((await idle(m, first.id)).text, /Integration/);
});

for (const cli of ['pi', 'codex']) test(`${cli} keeps one worker/CLI and distinct results across idle turns`, { timeout: 25000 }, async t => {
  const { cwd, parent, m, codex } = setup(t);
  const started = await m.spawn('worker', cli === 'codex' ? { ...role, cli, model: 'fixture' } : role, cwd, 'REMEMBER alpha');
  const first = await idle(m, started.id), dir = path.join(m.root, first.id);
  assert.equal(first.protocolVersion, 2); assert.ok(first.runtimeId);
  assert.ok(processAlive(first.workerPid)); assert.ok(processAlive(first.cliPid)); assert.ok(fs.existsSync(path.join(dir, 'owner.lock')));
  const report = JSON.stringify(m.getResult(first.id, first.runId));
  const reopened = new AgentManager(parent, pi, codex);
  await reopened.send(first.id, 'RECALL'); const second = await idle(reopened, first.id);
  assert.equal(second.text, 'alpha'); assert.notEqual(second.runId, first.runId);
  for (const key of ['workerPid', 'cliPid', 'runtimeId', 'sessionId', 'logFile']) assert.equal(second[key], first[key], key);
  assert.equal(JSON.stringify(m.getResult(first.id, first.runId)), report, 'new assignment must not rewrite the old result');
  assert.equal(m.eventLogs(first.id).length, 1, 'shared runtime log must not be replayed twice');
  assert.equal(m.reports(Date.now() + 60 * 60_000).some(r => r.status === 'stalled'), false);
  const closed = await m.close(first.id); assert.equal(closed.phase, 'closed'); assert.equal(closed.lastStatus, 'completed');
  assert.equal(fs.existsSync(path.join(dir, 'owner.lock')), false);
  const saved = readJson(path.join(dir, 'state.json'));
  assert.equal(saved.phase, 'completed', 'closed snapshot is readable by the old phase validator'); assert.equal(saved.runtimeClosed, true);
  await m.send(first.id, 'RECALL'); const resumed = await idle(m, first.id);
  assert.equal(resumed.sessionId, first.sessionId); assert.notEqual(resumed.runtimeId, first.runtimeId);
  assert.equal(resumed.text, 'alpha'); assert.equal(m.eventLogs(first.id).length, 2);
});

test('v2 rejects legacy control and stale runtime/run identities without stopping new work', { timeout: 20000 }, async t => {
  const { cwd, m } = setup(t); const child = await m.spawn('worker', role, cwd, 'REMEMBER protocol');
  const first = await idle(m, child.id), file = path.join(m.root, child.id, 'endpoint.json');
  const endpoint = readJson(file);
  await assert.rejects(control({ port: endpoint.port, token: endpoint.token, runId: endpoint.runId }, { type: 'close' }), /protocol|identity/i);
  await assert.rejects(control({ ...endpoint, runtimeId: randomUUID() }, { type: 'close' }), /runtime|identity/i);
  await m.send(child.id, 'HOLD next');
  await assert.rejects(control(endpoint, { type: 'close' }), /run|identity/i);
  assert.equal(m.get(child.id).phase, 'running'); assert.equal(m.get(child.id).runtimeId, first.runtimeId);
  const current = readJson(file);
  await assert.rejects(control(current, { type: 'close', onlyIdle: true }), /idle/i);
  assert.equal(m.get(child.id).phase, 'running');
});

test('resident log references are instance-contained and cannot expose arbitrary files', { timeout: 20000 }, async t => {
  const { cwd, m } = setup(t); const child = await m.spawn('worker', role, cwd, 'REMEMBER logs'); await idle(m, child.id);
  await m.send(child.id, 'RECALL'); const second = await idle(m, child.id);
  const file = path.join(m.root, child.id, 'runs', second.runId, 'request.json'); const request = readJson(file);
  writeJson(file, { ...request, logFile: path.join(cwd, 'foreign.jsonl') });
  assert.throws(() => m.eventLogs(child.id), /log|outside|reference/i);
  writeJson(file, request);
  await m.close(child.id);
  const runs = path.join(m.root, child.id, 'runs'), backup = `${runs}.saved`, outside = path.join(cwd, 'outside-logs');
  await waitUntil('released worker log handles', () => {
    try { fs.renameSync(runs, backup); return true; }
    catch (error) { if (['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) return false; throw error; }
  }, 5000);
  fs.cpSync(backup, outside, { recursive: true });
  try {
    fs.symlinkSync(outside, runs, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => m.eventLogs(child.id), /escapes|outside/i, 'runs directory must not redefine the trusted root');
  } finally { if (fs.existsSync(runs)) fs.unlinkSync(runs); fs.renameSync(backup, runs); }
});

test('idle writers block integration; sync closes the writer before changing its baseline', { timeout: 30000 }, async t => {
  const { cwd, m } = setup(t); const repo = path.join(cwd, 'repo'); fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base'); git('add', '.'); git('commit', '-qm', 'fixture');
  const ws = await m.workspaces.create(repo); const child = await m.spawn('worker', role, repo, 'CWD', ws.id); const first = await idle(m, child.id);
  await assert.rejects(m.workspaces.integrate(ws.id), /occupied/);
  fs.writeFileSync(path.join(repo, 'parent.txt'), 'next'); git('add', '.'); git('commit', '-qm', 'parent');
  await assert.rejects(m.send(child.id, 'MUST NOT START', 'steer', { baseline: 'sync', expectedRevision: ws.revision + 1 }), /baseline changed/);
  assert.equal(m.get(child.id).phase, 'idle', 'invalid confirmation metadata must not close a writer');
  const endpointFile = path.join(m.root, child.id, 'endpoint.json'), savedEndpoint = readJson(endpointFile);
  writeJson(endpointFile, { ...savedEndpoint, token: 'invalid-close-proof' });
  try {
    await assert.rejects(m.send(child.id, 'MUST NOT START', 'steer', { baseline: 'sync' }), /forbidden/);
    assert.equal(fs.existsSync(path.join(ws.path, 'parent.txt')), false, 'failed close must not synchronize files');
    assert.equal(m.get(child.id).runtimeId, first.runtimeId); assert.ok(processAlive(first.cliPid));
    assert.equal(m.workspaces.get(ws.id).baseCommit, ws.baseCommit);
  } finally { writeJson(endpointFile, savedEndpoint); }
  await m.send(child.id, 'CWD', 'steer', { baseline: 'sync' }); const next = await idle(m, child.id);
  assert.notEqual(next.runtimeId, first.runtimeId); assert.equal(next.sessionId, first.sessionId);
  assert.equal(fs.readFileSync(path.join(ws.path, 'parent.txt'), 'utf8'), 'next');
  fs.writeFileSync(path.join(ws.path, 'background.txt'), 'idle is still a writer');
  await assert.rejects(m.workspaces.integrate(ws.id), /occupied/);
  assert.equal(fs.existsSync(path.join(repo, 'background.txt')), false);
  await m.close(child.id); await m.workspaces.integrate(ws.id);
  assert.equal(fs.readFileSync(path.join(repo, 'background.txt'), 'utf8'), 'idle is still a writer');
});

for (const action of ['interrupt', 'close']) test(`startup ${action} cannot fabricate an ended native turn`, { timeout: 20000 }, async t => {
  const { cwd, home, m } = setup(t, ['--hold-ready']);
  const spawning = m.spawn('worker', { ...role, cli: 'codex', model: 'fixture' }, cwd, 'REMEMBER ready');
  const pending = await waitUntil('ready barrier', () => {
    const s = m.list().find(s => s.phase === 'starting' && s.cliPid);
    const requests = path.join(home, 'requests.jsonl');
    return s && fs.existsSync(requests) && fs.readFileSync(requests, 'utf8').includes('"method":"thread/start"') ? s : undefined;
  }, 5000);
  const endpoint = readJson(path.join(m.root, pending.id, 'endpoint.json'));
  try {
    if (action === 'interrupt') {
      await assert.rejects(control(endpoint, { type: 'interrupt' }), /captured turn|startup/);
      await assert.rejects(control(endpoint, { type: 'start', message: 'MUST NOT START' }), /idle/);
      assert.throws(() => m.getResult(pending.id, pending.runId), /No final result/);
      fs.writeFileSync(path.join(home, 'release-ready'), ''); await spawning;
      assert.equal((await idle(m, pending.id)).runCount, 1);
      assert.equal(m.getResult(pending.id, pending.runId).status, 'completed');
    } else {
      await control(endpoint, { type: 'close' }); await spawning;
      await waitUntil('closed during ready', () => m.get(pending.id).phase === 'closed');
      assert.equal(m.getResult(pending.id, pending.runId).status, 'stopped');
      assert.equal(fs.existsSync(path.join(m.root, pending.id, 'owner.lock')), false);
      assert.equal(fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').includes('"method":"turn/start"'), false);
    }
    assert.equal(m.reports().filter(r => r.notificationId === `${pending.runId}-result`).length, 1);
  } finally { fs.writeFileSync(path.join(home, 'release-ready'), ''); await spawning.catch(() => {}); }
});

for (const cli of ['pi', 'codex']) test(`${cli} confirmed interruption leaves the same runtime available for the next run`, { timeout: 20000 }, async t => {
  const { cwd, m } = setup(t);
  const first = await m.spawn('worker', cli === 'codex' ? { ...role, cli, model: 'fixture' } : role, cwd, 'HOLD');
  await control(readJson(path.join(m.root, first.id, 'endpoint.json')), { type: 'interrupt' });
  const stopped = await idle(m, first.id, 'stopped');
  await m.send(first.id, 'REMEMBER next'); const next = await idle(m, first.id);
  assert.equal(next.runtimeId, first.runtimeId); assert.equal(next.cliPid, first.cliPid);
  assert.notEqual(next.runId, stopped.runId); assert.equal(m.getResult(first.id, first.runId).status, 'stopped');
});

test('idle CLI exit produces a runtime notice without replacing its completed result', { timeout: 15000 }, async t => {
  const { cwd, home, m } = setup(t, ['--exit-when-idle']);
  const child = await m.spawn('worker', { ...role, cli: 'codex', model: 'fixture' }, cwd, 'REMEMBER done');
  const first = await idle(m, child.id), original = JSON.stringify(m.getResult(child.id, first.runId));
  fs.writeFileSync(path.join(home, 'exit-idle'), '');
  await waitUntil('idle native exit', () => m.get(child.id).phase === 'closed');
  assert.equal(JSON.stringify(m.getResult(child.id, first.runId)), original);
  const reports = m.reports(); assert.ok(reports.some(r => r.notificationId === `${first.runtimeId}-exited`));
  assert.equal(reports.some(r => r.notificationId.endsWith('-unreachable')), false);
});

test('a half-open control connection does not hold a reaped native writer lock', { timeout: 15000 }, async t => {
  const { cwd, m } = setup(t); const child = await m.spawn('worker', role, cwd, 'REMEMBER done'); await idle(m, child.id);
  const endpoint = readJson(path.join(m.root, child.id, 'endpoint.json'));
  const socket = connect(endpoint.port, '127.0.0.1'); await once(socket, 'connect'); socket.write('POST / HTTP/1.1\r\n');
  try {
    const start = Date.now(); const closed = await m.close(child.id);
    assert.equal(closed.phase, 'closed'); assert.ok(Date.now() - start < 5000);
    assert.equal(fs.existsSync(path.join(m.root, child.id, 'owner.lock')), false);
  } finally { socket.destroy(); }
});

test('interrupt uncertainty keeps ownership and rejects new work until explicit release', { timeout: 50000 }, async t => {
  const { cwd, home, m } = setup(t, ['--ignore-interrupt']);
  const child = await m.spawn('worker', { ...role, cli: 'codex', model: 'fixture' }, cwd, 'HOLD');
  const endpoint = readJson(path.join(m.root, child.id, 'endpoint.json'));
  await assert.rejects(control(endpoint, { type: 'interrupt' }), /interrupt|uncertain|timed out/i);
  await assert.rejects(m.send(child.id, 'MUST NOT START'), /uncertain|interrupt|unreachable/i);
  assert.ok(fs.existsSync(path.join(m.root, child.id, 'owner.lock')));
  const requests = fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(requests.filter(r => r.method === 'turn/start').length, 1);
  await m.close(child.id);
});
