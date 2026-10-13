import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { once } from 'node:events';
import { createServer } from 'node:http';
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

function receipt(view, operation, status) {
  assert.deepEqual(view.receipt, { operation, status, runId: view.runId, ...(view.runtimeId ? { runtimeId: view.runtimeId } : {}) });
}
function noPersistedReceipt(m, id) {
  const dir = path.join(m.root, id);
  assert.equal(Object.hasOwn(m.get(id), 'receipt'), false, 'query is not an operation acknowledgement');
  assert.equal(Object.hasOwn(readJson(path.join(dir, 'state.json')), 'receipt'), false);
  const reports = path.join(dir, 'reports');
  for (const name of fs.existsSync(reports) ? fs.readdirSync(reports) : []) assert.equal(Object.hasOwn(readJson(path.join(reports, name)), 'receipt'), false);
}

// A local legacy/control peer, not a native CLI or a model. Exercises the real HTTP
// transport without modifying another worker's state or launching a replacement.
async function peer(t, protocolVersion, reply) {
  const cwd = tempDir('receipt-peer'), parent = path.join(cwd, 'parent.jsonl'); fs.writeFileSync(parent, '{}\n');
  const m = new AgentManager(parent, pi), id = randomUUID(), runId = randomUUID(), runtimeId = protocolVersion ? randomUUID() : undefined;
  const dir = path.join(m.root, id), calls = [];
  writeJson(path.join(dir, 'spec.json'), { version: 1, id, parentFile: parent, cwd, roleName: 'worker', role, launch: pi, createdAt: Date.now() });
  const state = { id, runId, phase: 'running', workerPid: process.pid, accepted: true, questions: [], updatedAt: Date.now(), logFile: path.join(dir, 'events.jsonl'),
    ...(protocolVersion ? { protocolVersion, runtimeId } : {}) };
  writeJson(path.join(dir, 'state.json'), state);
  if (protocolVersion) writeJson(path.join(dir, 'owner.lock'), { pid: process.pid, runId, runtimeId });
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push(JSON.parse(body));
    if (reply) reply(res, state, calls.at(-1));
    else res.end(JSON.stringify(state));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = { port: server.address().port, token: 'fixture-only', runId, ...(protocolVersion ? { protocolVersion, runtimeId } : {}) };
  writeJson(path.join(dir, 'endpoint.json'), endpoint);
  return { m, id, state, calls, endpoint };
}

for (const [phase, accepted] of [['completed', true], ['failed', false], ['running', true]]) {
  test(`workspace send keeps a validated closing response (${phase}, accepted=${accepted})`, async t => {
    const h = await peer(t, 2, (res, state) => {
      Object.assign(state, { phase, accepted, runtimeClosed: true, lastStatus: phase === 'failed' ? 'failed' : 'completed' });
      writeJson(path.join(h.m.root, h.id, 'state.json'), state);
      res.end(JSON.stringify({ ...state, receipt: { operation: 'send', status: accepted ? 'accepted' : 'unconfirmed', runId: state.runId, runtimeId: state.runtimeId } }));
    });
    const file = path.join(h.m.root, h.id, 'spec.json'), prior = { commit: 'a'.repeat(40), revision: 1 };
    writeJson(file, { ...readJson(file), workspace: randomUUID(), workspaceBaseline: prior });
    // Exercise the public send and real HTTP response while the workspace lease is held;
    // only Git preparation is stubbed. Keep owner.lock to pin the post-reap/pre-unlock window.
    t.mock.method(h.m.workspaces, 'runAgent', async (_workspace, id, action) => {
      assert.equal(id, h.id); return action({ baseCommit: 'b'.repeat(40), revision: 2 });
    });
    if (phase === 'running') {
      await assert.rejects(h.m.send(h.id, 'context'), /Invalid runtime identity/);
      assert.deepEqual(readJson(file).workspaceBaseline, prior, 'invalid wire state must still be rejected before updating the baseline');
    } else {
      const result = await h.m.send(h.id, 'context');
      assert.equal(result.phase, 'stopping'); assert.equal(result.runtimeClosed, true);
      assert.equal(result.runId, h.state.runId); assert.equal(result.runtimeId, h.state.runtimeId);
      receipt(result, 'send', accepted ? 'accepted' : 'unconfirmed');
      const baseline = accepted ? { commit: 'b'.repeat(40), revision: 2 } : prior;
      assert.deepEqual(result.workspaceBaseline, baseline); assert.deepEqual(readJson(file).workspaceBaseline, baseline);
      assert.equal(h.calls.length, 1, 'do not replay input after an already validated response');
    }
  });
}

for (const flag of ['--startup-dialog', '--startup-dialog-after-state', '--startup-dialog-with-state']) test(`worker preserves independent Pi startup UI ${flag}`, { timeout: 15000 }, async t => {
  const { cwd, m } = setup(t, [], [flag]);
  const first = await m.spawn('worker', role, cwd, 'after-dialog');
  assert.equal(first.phase, 'waiting');
  if (flag !== '--startup-dialog-after-state') assert.equal(first.accepted, false);
  receipt(first, 'start', first.accepted ? 'accepted' : 'unconfirmed');
  noPersistedReceipt(m, first.id);
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
  receipt(started, 'start', 'accepted'); noPersistedReceipt(m, first.id);
  const sent = await reopened.send(first.id, 'RECALL'); receipt(sent, 'send', 'accepted');
  assert.notEqual(sent.receipt.runId, first.runId);
  const second = await idle(reopened, first.id); noPersistedReceipt(m, first.id);
  assert.equal(second.text, 'alpha'); assert.notEqual(second.runId, first.runId);
  for (const key of ['workerPid', 'cliPid', 'runtimeId', 'sessionId', 'logFile']) assert.equal(second[key], first[key], key);
  assert.equal(JSON.stringify(m.getResult(first.id, first.runId)), report, 'new assignment must not rewrite the old result');
  assert.equal(m.eventLogs(first.id).length, 1, 'shared runtime log must not be replayed twice');
  assert.equal(m.reports(Date.now() + 60 * 60_000).some(r => r.status === 'stalled'), false);
  const closed = await m.close(first.id); assert.equal(closed.phase, 'closed'); assert.equal(closed.lastStatus, 'completed');
  receipt(closed, 'stop', 'released'); noPersistedReceipt(m, first.id);
  receipt(await m.interrupt(first.id), 'interrupt', 'not_running');
  assert.equal(fs.existsSync(path.join(dir, 'owner.lock')), false);
  const saved = readJson(path.join(dir, 'state.json'));
  assert.equal(saved.phase, 'completed', 'closed snapshot is readable by the old phase validator'); assert.equal(saved.runtimeClosed, true);
  const continued = await m.send(first.id, 'RECALL'); receipt(continued, 'send', 'accepted');
  const resumed = await idle(m, first.id);
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

test('captured idle release refuses a newer run or runtime and preserves completed reports', { timeout: 20000 }, async t => {
  const { cwd, m } = setup(t); const child = await m.spawn('worker', role, cwd, 'REMEMBER original');
  const first = await idle(m, child.id), expected = { runId: first.runId, runtimeId: first.runtimeId };
  const report = JSON.stringify(m.getResult(child.id, first.runId));
  await m.send(child.id, 'HOLD newer');
  await assert.rejects(m.close(child.id, true, expected), /idle|captured/i);
  assert.equal(m.get(child.id).phase, 'running');
  await m.interrupt(child.id); const next = await idle(m, child.id, 'stopped');
  await assert.rejects(m.close(child.id, true, expected), /captured.*no longer matches/i);
  await assert.rejects(m.close(child.id, true, { runId: next.runId, runtimeId: randomUUID() }), /captured.*no longer matches/i);
  assert.equal(m.get(child.id).phase, 'idle'); assert(processAlive(next.cliPid));
  receipt(await m.close(child.id, true, { runId: next.runId, runtimeId: next.runtimeId }), 'stop', 'released');
  assert.equal(JSON.stringify(m.getResult(child.id, first.runId)), report);
  await m.send(child.id, 'REMEMBER replacement'); const replacement = await idle(m, child.id);
  assert.notEqual(replacement.runtimeId, first.runtimeId);
  await assert.rejects(m.close(child.id, true, expected), /captured.*no longer matches/i);
  assert.equal(m.get(child.id).phase, 'idle'); assert(processAlive(replacement.cliPid));
});

test('idle release keeps the checked snapshot bound when work changes before the control request', { timeout: 15000 }, async t => {
  const { cwd, m } = setup(t); const child = await m.spawn('worker', role, cwd, 'REMEMBER first');
  const first = await idle(m, child.id), request = m.request.bind(m); let changed = false;
  t.mock.method(m, 'request', async (id, input, captured) => {
    if (input.type === 'close' && !changed) {
      changed = true; await m.send(id, 'REMEMBER new turn'); await idle(m, id);
    }
    return request(id, input, captured);
  });
  await assert.rejects(m.close(child.id, true, { runId: first.runId, runtimeId: first.runtimeId }), /stale|identity/i);
  const current = m.get(child.id);
  assert(changed); assert.equal(current.phase, 'idle'); assert.notEqual(current.runId, first.runId);
  assert.equal(current.runtimeId, first.runtimeId); assert(processAlive(current.cliPid));
});

test('idle release cannot report a later runtime as the captured release result', async t => {
  const { m, id, state } = await peer(t, 2, (res, prior) => {
    const result = { ...prior, phase: 'completed', runtimeClosed: true, lastStatus: 'completed' };
    writeJson(path.join(m.root, id, 'state.json'), { ...result, runId: randomUUID(), runtimeId: randomUUID() });
    fs.unlinkSync(path.join(m.root, id, 'owner.lock'));
    res.end(JSON.stringify({ ...result, receipt: { operation: 'stop', status: 'released', runId: prior.runId, runtimeId: prior.runtimeId } }));
  });
  state.phase = 'idle'; writeJson(path.join(m.root, id, 'state.json'), state);
  await assert.rejects(m.close(id, true, { runId: state.runId, runtimeId: state.runtimeId }), error => {
    assert.match(error.message, /release confirmation.*changed/i);
    assert(error.message.includes(state.runId)); assert(error.message.includes(state.runtimeId)); return true;
  });
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
  receipt(await m.send(child.id, 'CWD', 'steer', { baseline: 'sync' }), 'send', 'accepted'); const next = await idle(m, child.id);
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
      const noTurn = await m.interrupt(pending.id); receipt(noTurn, 'interrupt', 'not_running');
      assert.equal(noTurn.accepted, false, 'no-op interrupt does not cancel or accept the pending assignment');
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
  const interrupted = await m.interrupt(first.id); receipt(interrupted, 'interrupt', 'settled');
  const stopped = await idle(m, first.id, 'stopped');
  receipt(await m.interrupt(first.id), 'interrupt', 'not_running');
  noPersistedReceipt(m, first.id);
  receipt(await m.send(first.id, 'REMEMBER next'), 'send', 'accepted'); const next = await idle(m, first.id);
  assert.equal(next.runtimeId, first.runtimeId); assert.equal(next.cliPid, first.cliPid);
  assert.notEqual(next.runId, stopped.runId); assert.equal(m.getResult(first.id, first.runId).status, 'stopped');
});

for (const [mode, message] of [['steer', 'B done'], ['followUp', 'HOLD B']]) test(`Pi in-flight ${mode} keeps native B in its captured assignment`, { timeout: 15000 }, async t => {
  const { cwd, m } = setup(t); const first = await m.spawn('worker', role, cwd, 'HOLD A');
  const native = () => readJson(first.sessionFile);
  const pending = m.send(first.id, 'DEFER_INPUT ' + JSON.stringify({ key: 'b', message }), mode);
  void pending.catch(() => {});
  try {
    await waitUntil('native A terminal while B input handler is gated', () => native().fixtureSettledCount === 1 && fs.readFileSync(first.logFile, 'utf8').includes('agent_settled'));
    // B stays held independently of all RPC queries. Give the real worker's old
    // idle-check path time to drain, rather than racing a send against a timer.
    await new Promise(resolve => setTimeout(resolve, 150));
  } finally { fs.writeFileSync(path.join(cwd, 'input-b.release'), ''); }
  const sent = await pending; receipt(sent, 'send', 'accepted'); assert.equal(sent.runId, first.runId);
  const during = m.get(first.id);
  if (message === 'HOLD B') {
    assert.equal(native().fixtureActive, true, 'native B really started, it was not just a receipt');
    assert.equal(during.phase, 'running', JSON.stringify({ host: during.phase, nativeActive: native().fixtureActive, publishedText: during.text }));
    assert.throws(() => m.getResult(first.id, first.runId), /No final result/, 'A must not be published before the admitted input finishes');
    receipt(await m.interrupt(first.id), 'interrupt', 'settled');
  }
  const result = await idle(m, first.id, message === 'HOLD B' ? 'stopped' : 'completed');
  assert.equal(result.text, message === 'HOLD B' ? 'ABORTED' : 'B done'); assert.equal(result.runId, first.runId);
  assert.equal(m.reports().filter(r => r.notificationId === `${first.runId}-result`).length, 1);
  const original = JSON.stringify(m.getResult(first.id, first.runId));
  const third = await m.send(first.id, 'third task'); const done = await idle(m, first.id);
  assert.equal(done.runId, third.runId); assert.notEqual(done.runId, first.runId); assert.equal(done.text, 'third task');
  for (const key of ['runtimeId', 'cliPid', 'workerPid', 'sessionId']) assert.equal(done[key], first[key], key);
  assert.equal(JSON.stringify(m.getResult(first.id, first.runId)), original);
  assert.deepEqual(native().fixtureInputRequests, ['b']); assert.equal(done.runCount, 2);
});

test('P3 busy Pi sends acknowledge only this request, including followUp, without durable receipts', { timeout: 15000 }, async t => {
  const { cwd, m } = setup(t); const child = await m.spawn('worker', role, cwd, 'HOLD');
  receipt(child, 'start', 'accepted');
  for (const mode of ['steer', 'followUp']) {
    const sent = await m.send(child.id, `HOLD ${mode}`, mode); receipt(sent, 'send', 'accepted');
    assert.equal(sent.runId, child.runId); assert.equal(sent.runtimeId, child.runtimeId);
    noPersistedReceipt(m, child.id);
  }
  const endpoint = readJson(path.join(m.root, child.id, 'endpoint.json'));
  const direct = await control(endpoint, { type: 'send', message: 'HOLD direct', mode: 'steer' }); receipt(direct, 'send', 'accepted');
  assert.equal(Object.hasOwn(await control(endpoint, { type: 'status' }), 'receipt'), false);
  const native = readJson(child.sessionFile).messages.filter(m => m.role === 'user').map(m => m.content);
  assert.deepEqual(native, ['HOLD', 'HOLD steer', 'HOLD followUp', 'HOLD direct']);
});

test('P3 Codex unsupported followUp is not sent and its previous acceptance is not a new receipt', { timeout: 15000 }, async t => {
  const { cwd, m, home } = setup(t); const child = await m.spawn('worker', { ...role, cli: 'codex', model: 'fixture' }, cwd, 'HOLD');
  const requests = () => fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const before = requests().length;
  await assert.rejects(m.send(child.id, 'must-not-send', 'followUp'), error => {
    assert.match(error.message, /not supported/i);
    for (const value of [child.id, child.runId, child.runtimeId]) assert(error.message.includes(value), error.message);
    return true;
  });
  assert.equal(requests().length, before);
  receipt(await m.send(child.id, 'HOLD next', 'steer'), 'send', 'accepted');
  assert.equal(requests().filter(r => r.method === 'turn/start').length, 1);
  assert.equal(requests().filter(r => r.method === 'turn/steer').length, 1);
  noPersistedReceipt(m, child.id);
});

test('Claude missing native capabilities reject busy input and interrupt without changing the active run', { timeout: 15000 }, async t => {
  const { cwd, parent, home, m, codex } = setup(t);
  const cm = new AgentManager(parent, pi, codex, { home, launch: { command: process.execPath, args: [fixture('claude'), '--no-lifecycle-cap', '--no-cancel-cap'] } });
  const child = await cm.spawn('worker', { ...role, cli: 'claude' }, cwd, 'HOLD'); receipt(child, 'start', 'accepted');
  const requests = () => fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const before = requests().length;
  for (const operation of [() => cm.send(child.id, 'must-not-send', 'steer'), () => cm.send(child.id, 'must-not-send', 'followUp'), () => cm.interrupt(child.id)]) {
    await assert.rejects(operation(), /capabilit/i);
    assert.equal(requests().length, before); assert.equal(cm.get(child.id).phase, 'running');
  }
  noPersistedReceipt(m, child.id);
});

for (const version of [undefined, 2]) test(`P3 a worker without receipts stays unconfirmed (protocol ${version ?? 'legacy'})`, async t => {
  const { m, id, state, calls } = await peer(t, version);
  const sent = await m.send(id, 'once'); receipt(sent, 'send', 'unconfirmed'); assert.equal(sent.accepted, true);
  if (version === undefined) await assert.rejects(m.interrupt(id), /legacy|resident v2/i);
  else receipt(await m.interrupt(id), 'interrupt', 'unconfirmed');
  assert.equal(calls.filter(r => r.type === 'send').length, 1);
  assert.equal(calls.filter(r => r.type === 'interrupt').length, version ? 1 : 0);
  assert.equal(Object.hasOwn(m.get(id), 'receipt'), false);
  writeJson(path.join(m.root, id, 'state.json'), { ...state, receipt: { operation: 'send', status: 'accepted', runId: state.runId } });
  assert.equal(Object.hasOwn(m.get(id), 'receipt'), false, 'query must not replay even a stray persisted receipt');
});

test('P3 initial acknowledgement and final outcome remain different facts', { timeout: 15000 }, async t => {
  const { cwd, m } = setup(t);
  const rejected = await m.spawn('worker', role, cwd, 'REJECT'); receipt(rejected, 'start', 'unconfirmed');
  assert.equal(rejected.accepted, false); assert.equal(rejected.lastStatus, 'failed');
  const failed = await m.spawn('worker', role, cwd, 'FAIL'); receipt(failed, 'start', 'accepted');
  await idle(m, failed.id, 'failed');
  receipt(await m.send(failed.id, 'REMEMBER recovered'), 'send', 'accepted'); await idle(m, failed.id);
  noPersistedReceipt(m, rejected.id); noPersistedReceipt(m, failed.id);
});

test('P3 an absent owner lock or legacy response alone is not proof of released native resources', async t => {
  for (const version of [undefined, 2]) {
    const { m, id } = await peer(t, version, (res, state) => {
      fs.rmSync(path.join(path.dirname(state.logFile), 'owner.lock'), { force: true });
      res.end(JSON.stringify({ ...state, ...(version ? { receipt: { operation: 'stop', status: 'released', runId: state.runId, runtimeId: state.runtimeId } } : {}) }));
    });
    receipt(await m.close(id), 'stop', 'unconfirmed');
  }
});

test('P3 invalid or stale worker receipts are rejected without replay', async t => {
  const { m, id, calls } = await peer(t, 2, (res, state) => res.end(JSON.stringify({ ...state,
    receipt: { operation: 'send', status: 'accepted', runId: randomUUID(), runtimeId: state.runtimeId },
  })));
  await assert.rejects(m.send(id, 'one attempt'), /Invalid worker operation receipt.*uncertain/);
  assert.equal(calls.length, 1);
});

test('P3 lost control response retains known identity diagnostics and is never replayed', async t => {
  const { m, id, state, calls } = await peer(t, 2, res => res.destroy());
  await assert.rejects(m.send(id, 'one side effect'), error => {
    for (const value of [id, state.runId, state.runtimeId]) assert(error.message.includes(value), error.message);
    return true;
  });
  assert.equal(calls.length, 1); assert.equal(calls[0].type, 'send');
  assert.equal(Object.hasOwn(m.get(id), 'receipt'), false);
});

test('P3 interrupt reports the captured settled run, not an interruption verdict or a newer snapshot', async t => {
  const nextRun = randomUUID();
  const { m, id, state, calls } = await peer(t, 2, (res, prior, input) => {
    assert.equal(input.type, 'interrupt');
    writeJson(path.join(path.dirname(prior.logFile), 'state.json'), { ...prior, runId: nextRun });
    res.end(JSON.stringify({ ...prior, phase: 'idle', lastStatus: 'completed', receipt: {
      operation: 'interrupt', status: 'settled', runId: prior.runId, runtimeId: prior.runtimeId,
    } }));
  });
  const result = await m.interrupt(id); receipt(result, 'interrupt', 'settled');
  assert.equal(result.runId, state.runId); assert.equal(result.lastStatus, 'completed');
  assert.equal(m.get(id).runId, nextRun); assert.equal(calls.length, 1);
});

test('P3 no-op interrupt and repeated stop preserve a naturally completed result', { timeout: 15000 }, async t => {
  const { cwd, m } = setup(t); const child = await m.spawn('worker', role, cwd, 'REMEMBER finished'); await idle(m, child.id);
  const original = JSON.stringify(m.getResult(child.id, child.runId));
  receipt(await m.interrupt(child.id), 'interrupt', 'not_running');
  assert.equal(JSON.stringify(m.getResult(child.id, child.runId)), original);
  receipt(await m.close(child.id), 'stop', 'released');
  receipt(await m.close(child.id), 'stop', 'released');
  receipt(await m.interrupt(child.id), 'interrupt', 'not_running');
  assert.equal(JSON.stringify(m.getResult(child.id, child.runId)), original);
  noPersistedReceipt(m, child.id);
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
  await assert.rejects(m.interrupt(child.id), error => {
    assert.match(error.message, /interrupt|uncertain|timed out/i);
    for (const value of [child.id, child.runId, child.runtimeId]) assert(error.message.includes(value), error.message);
    return true;
  });
  await assert.rejects(m.send(child.id, 'MUST NOT START'), /uncertain|interrupt|unreachable/i);
  assert.ok(fs.existsSync(path.join(m.root, child.id, 'owner.lock')));
  const requests = fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(requests.filter(r => r.method === 'turn/start').length, 1);
  await m.close(child.id);
});
