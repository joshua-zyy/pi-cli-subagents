import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentManager } from '../dist/manager.js';
import { defaultRoles } from '../dist/roles.js';
import { processAlive, waitUntil, readJson } from '../dist/storage.js';

const fixture = fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url));
const launch = { command: process.execPath, args: [fixture] };
const output = path.resolve('.test-output'); fs.mkdirSync(output, { recursive: true });
function setup(t) {
  const cwd = fs.mkdtempSync(path.join(output, 'manager-'));
  const parent = path.join(cwd, 'parent.jsonl'); fs.writeFileSync(parent, '{}\n');
  const manager = new AgentManager(parent, launch);
  t.after(async () => {
    for (const state of manager.list()) {
      if (processAlive(state.workerPid)) await manager.close(state.id);
      assert.equal(processAlive(manager.get(state.id).workerPid), false, 'worker must be reaped');
      assert.equal(processAlive(manager.get(state.id).cliPid), false, 'CLI must be reaped');
    }
  });
  return { cwd, parent, manager };
}
const complete = (manager, id, phase = 'completed') => waitUntil('terminal state and process release', () => {
  const state = manager.get(id);
  return state.phase === phase && !processAlive(state.workerPid) ? state : undefined;
}, 15_000);

test('complete, release, then resume the original native session', { timeout: 20_000 }, async t => {
  const { cwd, manager } = setup(t);
  const started = await manager.spawn('worker', defaultRoles.worker, cwd, 'REMEMBER alpha');
  const first = await complete(manager, started.id);
  assert.equal(first.text, 'OK'); assert.ok(fs.existsSync(first.sessionFile));
  const next = await manager.send(first.id, 'RECALL');
  const resumed = await complete(manager, next.id);
  assert.equal(resumed.text, 'alpha'); assert.equal(resumed.sessionId, first.sessionId);
  assert.equal(resumed.sessionFile, first.sessionFile); assert.notEqual(resumed.workerPid, first.workerPid);
  assert.equal(manager.list().length, 1); assert.equal(manager.reports().length, 2);
});

test('a fresh controller reattaches after the original parent exits', { timeout: 20_000 }, async t => {
  const { cwd, parent, manager } = setup(t);
  const module = new URL('../dist/manager.js', import.meta.url).href;
  const code = `const {AgentManager}=await import(${JSON.stringify(module)});const m=new AgentManager(${JSON.stringify(parent)},${JSON.stringify(launch)});const s=await m.spawn('worker',{description:'test',instructions:'test'},${JSON.stringify(cwd)},'HOLD');console.log(JSON.stringify({parentPid:process.pid,...s}));`;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { timeout: 15_000 });
  const first = JSON.parse(result.stdout);
  assert.equal(processAlive(first.parentPid), false);
  assert.equal(processAlive(first.workerPid), true);
  assert.equal(manager.list()[0].cliPid, first.cliPid);
  const sent = await manager.send(first.id, 'FINISH', 'steer');
  assert.equal(sent.workerPid, first.workerPid);
  const done = await complete(manager, first.id);
  assert.equal(done.text, 'FINISH'); assert.equal(done.sessionId, first.sessionId);
});

test('force-killed controller does not cancel the already accepted child', { timeout: 20_000 }, async t => {
  const { cwd, parent, manager } = setup(t);
  const module = new URL('../dist/manager.js', import.meta.url).href;
  const code = `const {AgentManager}=await import(${JSON.stringify(module)});const m=new AgentManager(${JSON.stringify(parent)},${JSON.stringify(launch)});const s=await m.spawn('worker',{description:'test',instructions:'test'},${JSON.stringify(cwd)},'HOLD');console.log(JSON.stringify(s));setInterval(()=>{},1000);`;
  const controller = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore','pipe','pipe'], windowsHide: true });
  let buffer = '';
  const ready = new Promise((resolve, reject) => {
    controller.stdout.on('data', chunk => {buffer += chunk; if(buffer.includes('\n'))resolve(JSON.parse(buffer.split('\n')[0]));});
    controller.once('error', reject);
    controller.once('exit', () => {if(!buffer.includes('\n'))reject(Error('controller exited before spawn'));});
  });
  let child;
  try {
    child = await ready;
    assert.ok(processAlive(child.workerPid));
    controller.kill('SIGKILL');
    await new Promise(resolve=>controller.once('close',resolve));
    assert.ok(processAlive(child.workerPid));
    const reattached = manager.get(child.id);
    assert.equal(reattached.cliPid, child.cliPid);
    assert.equal(reattached.sessionId, child.sessionId);
    await manager.send(child.id, 'AFTER-KILL');
    const result = await complete(manager, child.id);
    assert.equal(result.text, 'AFTER-KILL');
  } finally {
    if (processAlive(controller.pid)) controller.kill('SIGKILL');
  }
});

test('two independent children have distinct sessions', { timeout: 20_000 }, async t => {
  const { cwd, manager } = setup(t);
  const [a,b] = await Promise.all([
    manager.spawn('worker',defaultRoles.worker,cwd,'REMEMBER a'),
    manager.spawn('reviewer',defaultRoles.reviewer,cwd,'REMEMBER b'),
  ]);
  const [first,second] = await Promise.all([complete(manager,a.id),complete(manager,b.id)]);
  assert.notEqual(first.sessionId,second.sessionId);
  assert.notEqual(first.sessionFile,second.sessionFile);
  assert.equal(manager.list().length,2);
});

test('failures and rejected commands are not empty successes', { timeout: 20_000 }, async t => {
  const { cwd, manager } = setup(t);
  for (const message of ['FAIL', 'REJECT', 'CRASH']) {
    const start = await manager.spawn('worker', defaultRoles.worker, cwd, message);
    const end = await complete(manager, start.id, 'failed');
    assert.ok(end.error); assert.equal(manager.reports().find(r => r.agentId === end.id).status, 'failed');
  }
});

test('permissions remain waiting until an explicit human reply', { timeout: 20_000 }, async t => {
  const { cwd, manager } = setup(t);
  const start = await manager.spawn('worker', defaultRoles.worker, cwd, 'WAIT');
  await waitUntil('question', () => manager.get(start.id).phase === 'waiting');
  assert.equal(manager.get(start.id).questions.length, 1);
  assert.equal(manager.reports()[0].status, 'waiting');
  await assert.rejects(manager.send(start.id, 'yes'), /agent-reply/);
  await manager.reply(start.id, 'permission-1', { confirmed: false });
  assert.equal((await complete(manager, start.id)).text, 'DENY');
  assert.ok(manager.reports().every(r => r.status !== 'waiting'));
});

test('close stops active work without deleting the resumable session', { timeout: 20_000 }, async t => {
  const { cwd, manager } = setup(t);
  const start = await manager.spawn('worker', defaultRoles.worker, cwd, 'HOLD');
  const stopped = await manager.close(start.id);
  assert.equal(stopped.phase, 'stopped'); assert.ok(fs.existsSync(stopped.sessionFile));
  await manager.send(start.id, 'NEW');
  const next = await complete(manager, start.id);
  assert.equal(next.text, 'NEW'); assert.equal(next.sessionId, stopped.sessionId);
});

test('missing sessions, foreign ids and path traversal fail closed', { timeout: 20_000 }, async t => {
  const { cwd, manager, parent } = setup(t);
  const start = await manager.spawn('worker', defaultRoles.worker, cwd, 'DONE');
  const done = await complete(manager, start.id);
  fs.renameSync(done.sessionFile, `${done.sessionFile}.backup`);
  await assert.rejects(manager.send(done.id, 'RECALL'), /不会静默新建/);
  assert.throws(() => manager.get('../anything'), /无效/);
  assert.throws(() => new AgentManager(`${parent}.other`, launch).get(done.id), /不属于/);
});

test('racing resumes cannot start two CLI owners for the same session', { timeout: 20_000 }, async t => {
  const { cwd, manager, parent } = setup(t);
  const start = await manager.spawn('worker', defaultRoles.worker, cwd, 'DONE');
  await complete(manager, start.id);
  const other = new AgentManager(parent, launch);
  const outcomes = await Promise.allSettled([manager.send(start.id, 'HOLD one'), other.send(start.id, 'HOLD two')]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(x => x.status === 'rejected').length, 1);
  const state = manager.get(start.id);
  const lock = readJson(path.join(manager.root, start.id, 'owner.lock'));
  assert.equal(lock.pid, state.workerPid);
});
