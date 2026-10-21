import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { AgentManager } from '../dist/manager.js';
import { processAlive, readJson, writeJson, waitUntil } from '../dist/storage.js';
import { deliverReports } from '../dist/notifier.js';
import { tempDir } from './helpers/tmp.mjs';
const launch = { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url))] };
// Same PID-and-instance identity check as manager.test.mjs; a reused PID is not this worker.
function originalProcessAlive(pid, instanceDirectory) {
  if (!processAlive(pid)) return false;
  let commandLine;
  if (process.platform === 'win32') {
    commandLine = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  } else {
    try { commandLine = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' }); }
    catch (error) { if (error.status === 1) return false; throw error; }
  }
  const normalize = text => text.replace(/\\/g, '/').toLowerCase();
  return normalize(commandLine).includes(normalize(instanceDirectory));
}
const released = async (m, id) => {
  const result = await waitUntil('run result before release', () => {
    const s = m.get(id);
    return ['idle', 'closed'].includes(s.phase) ? s : undefined;
  }, 10000);
  assert.equal(result.lastStatus, 'completed');
  const closed = await m.close(id);
  assert.equal(closed.phase, 'closed'); assert.equal(closed.lastStatus, result.lastStatus);
  assert.equal(fs.existsSync(path.join(m.root, id, 'owner.lock')), false);
  return closed;
};
function setup(t) {
  const cwd = tempDir('manager-recovery');
  const m = new AgentManager(path.join(cwd, 'parent.jsonl'), launch);
  t.after(async () => {
    for (const s of m.list()) if (s.runId && fs.existsSync(path.join(m.root, s.id, 'owner.lock'))) await m.close(s.id);
  });
  return { cwd, m };
}

test('legacy managed inputs fail before state access, admission or dispatch in every phase', async t => {
  const { cwd, m } = setup(t);
  for (const method of ['get', 'admit', 'request', 'start']) t.mock.method(m, method, () => assert.fail(`${method} must not run`));
  for (const cli of ['pi', 'codex', 'claude']) for (const phase of ['starting', 'running', 'waiting', 'idle', 'closed', 'stopping', 'unreachable']) {
    const id = randomUUID(), dir = path.join(m.root, id), workspace = randomUUID();
    writeJson(path.join(dir, 'spec.json'), { version: cli === 'pi' ? 1 : cli === 'codex' ? 2 : 3,
      ...(cli === 'pi' ? {} : { cli, [`${cli}Home`]: cwd }), id, parentFile: m.parentFile, cwd,
      workspace, workspaceBaseline: { commit: 'a'.repeat(40), revision: 2 },
      roleName: 'worker', role: { description: 'test', instructions: 'test' }, launch, createdAt: 1 });
    writeJson(path.join(dir, 'state.json'), { phase, id });
    const before = fs.readdirSync(dir).map(file => [file, fs.readFileSync(path.join(dir, file))]);
    await assert.rejects(m.send(id, 'DO NOT EXECUTE'), /managed workspace.*retired/i);
    assert.deepEqual(fs.readdirSync(dir), before.map(([file]) => file));
    for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(dir, file)), bytes);
  }
  // These fixture records have no runtime to reap; do not call get() in the setup cleanup.
  t.mock.restoreAll();
});

test('saved delegation opt-ins refuse send and every public reply before state access or side effects', async t => {
  const cwd = tempDir('nested-legacy'), m = new AgentManager(path.join(cwd, 'parent.jsonl'), launch);
  for (const method of ['get', 'admit', 'request', 'start']) t.mock.method(m, method, () => assert.fail(`${method} must not run`));
  for (const cli of ['pi', 'codex', 'claude']) for (const phase of ['starting', 'running', 'waiting', 'idle', 'closed', 'stopping', 'unreachable']) {
    const id = randomUUID(), dir = path.join(m.root, id);
    writeJson(path.join(dir, 'spec.json'), { version: cli === 'pi' ? 1 : cli === 'codex' ? 2 : 3,
      ...(cli === 'pi' ? {} : { cli, [`${cli}Home`]: cwd }), id, parentFile: m.parentFile, cwd,
      roleName: 'worker', role: { cli, description: 'test', instructions: 'test', allowSubagents: true }, launch, createdAt: 1 });
    writeJson(path.join(dir, 'state.json'), { phase, id });
    const before = fs.readdirSync(dir).map(file => [file, fs.readFileSync(path.join(dir, file))]);
    for (const mode of ['steer', 'followUp']) await assert.rejects(m.send(id, 'MUST NOT EXECUTE', mode), /nested delegation is disabled/i);
    for (const actor of ['human', 'parent']) for (const answer of [{ confirmed: true }, { confirmed: false }, { cancelled: true }, { value: 'Deny once' }, { answers: {} }])
      await assert.rejects(m.reply(id, 'request', answer, { actor, reason: 'fixture' }), /nested delegation is disabled/i);
    assert.deepEqual(fs.readdirSync(dir), before.map(([file]) => file));
    for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(dir, file)), bytes);
  }
});

test('saved delegation opt-ins retain query, interrupt and release on all backends without rewriting history', { timeout: 30000 }, async t => {
  for (const cli of ['pi', 'codex', 'claude']) {
    const cwd = tempDir(`nested-release-${cli}`), home = path.join(cwd, 'home'); fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'fixture-home'), '');
    const native = { launch: { command: process.execPath, args: [fileURLToPath(new URL(`./fixtures/${cli}.mjs`, import.meta.url))] }, home };
    const m = new AgentManager(path.join(cwd, 'parent.jsonl'), launch, cli === 'codex' ? native : undefined, cli === 'claude' ? native : undefined);
    t.after(async () => { for (const state of m.list()) if (fs.existsSync(path.join(m.root, state.id, 'owner.lock'))) await m.close(state.id); });
    const child = await m.spawn('worker', { cli, description: 'fixture', instructions: 'fixture' }, cwd, cli === 'pi' ? 'WAIT' : 'APPROVAL');
    await waitUntil('pending fixture interaction', () => m.get(child.id).questions.length, 5000);
    const specFile = path.join(m.root, child.id, 'spec.json'), spec = readJson(specFile);
    spec.role.allowSubagents = true; writeJson(specFile, spec); const retained = fs.readFileSync(specFile);
    const observed = m.get(child.id); assert.equal(m.list()[0].id, child.id); assert.equal(observed.questions.length, 1);
    await assert.rejects(m.send(child.id, 'MUST NOT RESUME'), /nested delegation is disabled/i);
    await assert.rejects(m.reply(child.id, observed.questions[0].id, { cancelled: true }, { actor: 'parent', reason: 'fixture' }), /nested delegation is disabled/i);
    assert.equal(fs.existsSync(path.join(m.root, child.id, 'runs', child.runId, 'permissions.jsonl')), false);
    assert.equal((await m.interrupt(child.id)).receipt.status, 'settled');
    assert.equal((await m.close(child.id)).receipt.status, 'released');
    assert.equal(m.get(child.id).sessionId, child.sessionId); assert.equal(m.get(child.id).runCount, 1);
    assert.equal(m.getResult(child.id, child.runId).status, 'stopped');
    assert.deepEqual(fs.readFileSync(specFile), retained);
    await assert.rejects(m.send(child.id, 'MUST NOT RESTORE'), /nested delegation is disabled/i);
  }
});

test('current workers refuse saved delegation opt-ins before ownership or native launch', () => {
  const cwd = tempDir('nested-worker-startup'), worker = fileURLToPath(new URL('../dist/worker.js', import.meta.url));
  for (const cli of ['pi', 'codex', 'claude']) {
    const id = randomUUID(), runId = randomUUID(), dir = path.join(cwd, id);
    writeJson(path.join(dir, 'spec.json'), { version: cli === 'pi' ? 1 : cli === 'codex' ? 2 : 3,
      ...(cli === 'pi' ? {} : { cli, [`${cli}Home`]: cwd }), id, parentFile: path.join(cwd, 'parent.jsonl'), cwd,
      roleName: 'worker', role: { cli, description: 'test', instructions: 'test', allowSubagents: true },
      launch: { command: path.join(cwd, 'must-not-launch'), args: [] }, createdAt: 1 });
    writeJson(path.join(dir, 'runs', runId, 'request.json'), { protocolVersion: 3, runId, message: 'MUST NOT START' });
    assert.throws(() => execFileSync(process.execPath, [worker, dir, runId], { windowsHide: true, stdio: 'pipe', timeout: 15000 }), error => error.status === 1);
    assert.match(readJson(path.join(dir, 'runs', runId, 'error.json')).error, /nested delegation is disabled/i);
    for (const file of ['owner.lock', 'state.json', 'endpoint.json', 'sessions']) assert.equal(fs.existsSync(path.join(dir, file)), false, file);
  }
});

test('legacy managed records keep results, pending replies, interruption and release', { timeout: 20000 }, async t => {
  const { cwd, m } = setup(t), role = { description: 'test', instructions: 'test' };
  const markLegacy = id => {
    const file = path.join(m.root, id, 'spec.json');
    const spec = { ...readJson(file), workspace: randomUUID(), workspaceBaseline: { commit: 'b'.repeat(40), revision: 3 } };
    writeJson(file, spec); return { file, bytes: fs.readFileSync(file), spec };
  };
  const pending = await m.spawn('worker', role, cwd, 'WAIT');
  await waitUntil('legacy pending request', () => m.get(pending.id).questions.length);
  const saved = markLegacy(pending.id);
  const shown = m.get(pending.id);
  assert.equal(shown.workspace, saved.spec.workspace); assert.deepEqual(shown.workspaceBaseline, saved.spec.workspaceBaseline);
  await assert.rejects(m.send(pending.id, 'MUST NOT ANSWER'), /managed workspace.*retired/i);
  await m.reply(pending.id, shown.questions[0].id, { confirmed: true }, { actor: 'parent', reason: 'Authorized fixture reply' });
  const finished = await released(m, pending.id);
  assert.equal(m.getResult(pending.id, finished.runId).text, 'ALLOW');
  assert.deepEqual(fs.readFileSync(saved.file), saved.bytes);
  await assert.rejects(m.send(pending.id, 'MUST NOT RESUME'), /managed workspace.*retired/i);
  assert.equal(m.get(pending.id).runCount, 1);
  assert.equal(m.get(pending.id).phase, 'closed');
  const busy = await m.spawn('worker', role, cwd, 'HOLD legacy');
  const busySpec = markLegacy(busy.id);
  const interrupted = await m.interrupt(busy.id);
  assert.equal(interrupted.receipt.status, 'settled');
  const closed = await m.close(busy.id);
  assert.equal(closed.receipt.status, 'released');
  assert.equal(closed.sessionId, busy.sessionId);
  assert.deepEqual(fs.readFileSync(busySpec.file), busySpec.bytes);
  assert.equal(m.getResult(busy.id, busy.runId).status, 'stopped');
});

test('current worker refuses retired startup records before ownership or CLI launch', () => {
  const cwd = tempDir('retired-worker-startup'), worker = fileURLToPath(new URL('../dist/worker.js', import.meta.url));
  for (const protocolVersion of [undefined, 2]) {
    const id = randomUUID(), runId = randomUUID(), dir = path.join(cwd, id);
    writeJson(path.join(dir, 'spec.json'), { version: 1, id, parentFile: path.join(cwd, 'parent.jsonl'), cwd,
      roleName: 'worker', role: { description: 'test', instructions: 'test' }, launch: { command: path.join(cwd, 'must-not-launch'), args: [] }, createdAt: 1 });
    writeJson(path.join(dir, 'runs', runId, 'request.json'), { protocolVersion, runId, message: 'MUST NOT START' });
    assert.throws(() => execFileSync(process.execPath, [worker, dir, runId], { windowsHide: true, stdio: 'pipe', timeout: 15000 }), error => error.status === 1);
    assert.match(readJson(path.join(dir, 'runs', runId, 'error.json')).error, /Unsupported worker startup protocol/);
    for (const file of ['owner.lock', 'state.json', 'endpoint.json', 'sessions']) assert.equal(fs.existsSync(path.join(dir, file)), false, file);
  }
});

test('incomplete or unreadable registrations stay visible without blocking healthy notifications', { timeout: 15000 }, async t => {
  const { cwd, m } = setup(t);
  const good = await m.spawn('worker', { description: 'test', instructions: 'test' }, cwd, 'HEALTHY');
  await released(m, good.id);
  const spec = readJson(path.join(m.root, good.id, 'spec.json'));
  const bad = [];
  for (const kind of ['missing-state', 'malformed-state', 'empty-state', 'foreign-state', 'foreign-spec']) {
    const id = randomUUID(), dir = path.join(m.root, id); bad.push(id);
    writeJson(path.join(dir, 'spec.json'), { ...spec, id, ...(kind === 'foreign-spec' ? { parentFile: 'foreign' } : {}) });
    if (kind === 'malformed-state') fs.writeFileSync(path.join(dir, 'state.json'), '{');
    if (kind === 'empty-state') writeJson(path.join(dir, 'state.json'), {});
    if (kind === 'foreign-state') writeJson(path.join(dir, 'state.json'), readJson(path.join(m.root, good.id, 'state.json')));
  }
  const states = m.list(); assert.equal(states.length, 6);
  for (const id of bad) {
    const diagnostic = states.find(s => s.id === id);
    assert.equal(diagnostic.phase, 'unreachable'); assert.match(diagnostic.error, /record|inspect|unavailable/i);
    assert.equal(diagnostic.runId, '', 'no invented execution identity');
    assert.equal(diagnostic.session, undefined); assert.equal(diagnostic.history, undefined); assert.equal(diagnostic.runCount, undefined);
    assert.throws(() => m.get(id)); await assert.rejects(m.send(id, 'DO NOT RESTART')); await assert.rejects(m.close(id));
    assert(!fs.existsSync(path.join(m.root, id, 'runs')), 'diagnosis must not dispatch, recover or delete records');
  }
  const reports = m.reports(); assert.equal(reports.length, 1); assert.equal(reports[0].agentId, good.id);
  const messages = [];
  deliverReports(m, { sendMessage: message => messages.push(message) }, { sessionManager: { getEntries: () => [] }, ui: { notify() {}, setStatus() {} } }, new Set(), Date.now() + 3000, states);
  assert.equal(messages.length, 1); assert.match(messages[0].content, /HEALTHY/);
  assert(!messages[0].content.includes('-unreachable'), 'no fabricated failed run for an incomplete registration');
});

test('terminal worker PID reuse does not block close or original-session continuation', { timeout: 40000 }, async t => {
  const { cwd, m } = setup(t);
  const first = await m.spawn('worker', { description: 'test', instructions: 'test' }, cwd, 'REMEMBER original');
  const end = await released(m, first.id), stateFile = path.join(m.root, first.id, 'state.json');
  const original = readJson(stateFile); writeJson(stateFile, { ...original, workerPid: process.pid });
  try {
    const start = Date.now();
    const closed = await m.close(first.id);
    assert.equal(closed.sessionId, end.sessionId); assert(Date.now() - start < 1000);
    await m.send(first.id, 'RECALL'); const next = await released(m, first.id);
    assert.equal(next.text, 'original'); assert.equal(next.sessionId, end.sessionId);
    assert.equal(next.sessionFile, end.sessionFile); assert.equal(next.runCount, 2);
  } finally {
    if (readJson(stateFile).runId === original.runId) writeJson(stateFile, original);
  }
});

test('terminal records with a stale ownership lock are not reclaimed or resumed', { timeout: 15000 }, async t => {
  const { cwd, m } = setup(t);
  const first = await m.spawn('worker', { description: 'test', instructions: 'test' }, cwd, 'DONE'); await released(m, first.id);
  const lock = path.join(m.root, first.id, 'owner.lock');
  await waitUntil('original released worker exit', () => !originalProcessAlive(first.workerPid, path.dirname(lock)), 5000);
  try {
    for (const owner of [{ pid: 2147483647, runId: first.runId }, null, {}, { pid: process.pid, runId: randomUUID() }]) {
      writeJson(lock, owner);
      await assert.rejects(m.send(first.id, 'DO NOT RESTART'), /lock|owner/i);
      await assert.rejects(m.close(first.id), /lock|owner/i);
      assert(fs.existsSync(lock)); assert.equal(m.get(first.id).runCount, 1);
    }
  } finally { fs.unlinkSync(lock); }
});
