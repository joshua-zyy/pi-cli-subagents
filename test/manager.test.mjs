import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { AgentManager } from '../dist/manager.js';
import { defaultRoles } from '../dist/roles.js';
import { processAlive, waitUntil, readJson, writeJson } from '../dist/storage.js';
import { tempDir } from './helpers/tmp.mjs';

const fixture = fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url));
const launch = { command: process.execPath, args: [fixture] };
// A saved PID can belong to another process after exit, especially on Windows.
// The unique instance directory is present in both worker and CLI argv.
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
function setup(t) {
  const cwd = tempDir('manager');
  const parent = path.join(cwd, 'parent.jsonl'); fs.writeFileSync(parent, '{}\n');
  const manager = new AgentManager(parent, launch);
  t.after(async () => {
    for (const state of manager.list()) {
      if (processAlive(state.workerPid)) await manager.close(state.id);
      const directory = path.join(manager.root, state.id);
      // Lock release follows CLI reaping, but the worker may still be draining its event loop.
      await waitUntil('original worker exit', () => !originalProcessAlive(manager.get(state.id).workerPid, directory), 5000);
      const final = manager.get(state.id);
      assert.notEqual(final.exitCode, undefined, 'worker must have observed the CLI close event');
      assert.equal(originalProcessAlive(final.cliPid, directory), false, 'the original CLI must be reaped, not just its old PID');
    }
  });
  return { cwd, parent, manager };
}
const complete = async (manager, id, status = 'completed') => {
  const state = await waitUntil('run result', () => {
    const current = manager.get(id);
    return ['idle', 'closed'].includes(current.phase) ? current : undefined;
  }, 15_000);
  assert.equal(state.lastStatus, status);
  return state;
};
const release = async (manager, id, status = 'completed') => {
  await complete(manager, id, status);
  const closed = await manager.close(id);
  assert.equal(closed.phase, 'closed'); assert.equal(closed.lastStatus, status);
  assert.equal(fs.existsSync(path.join(manager.root, id, 'owner.lock')), false);
  return closed;
};

test('a rejected role is refused before any instance or process is created', async t => {
  const { cwd, manager } = setup(t);
  for (const role of [{ description: 'test', instructions: 'test', mode: 'plan' },
    { description: 'test', instructions: 'test', cli: 'codex', model: 'm', mode: 'bypassPermissions' },
    { description: 'test', instructions: 'test', cli: 'claude', mode: 'workspace-write' }]) {
    await assert.rejects(manager.spawn('worker', role, cwd, 'DO NOT START'), /mode/);
  }
  assert.equal(manager.list().length, 0, 'validation happens before the instance directory is created');
});

test('CLI cleanup checks distinguish the live original CLI from an unrelated reused PID', { timeout: 30_000 }, async t => {
  const { cwd, manager } = setup(t);
  const state = await manager.spawn('worker', defaultRoles.worker, cwd, 'HOLD identity');
  const directory = path.join(manager.root, state.id);
  assert.equal(originalProcessAlive(state.cliPid, directory), true, 'must detect a real running child');
  assert.equal(originalProcessAlive(state.workerPid, directory), true, 'must detect a real running worker');
  assert.equal(processAlive(process.pid), true);
  assert.equal(originalProcessAlive(process.pid, directory), false,
    'PID existence alone must not report an unrelated process as a leaked child');
  await manager.close(state.id);
  assert.equal(originalProcessAlive(manager.get(state.id).cliPid, directory), false);
});

test('complete, release, then resume the original native session', { timeout: 20_000 }, async t => {
  const { cwd, manager } = setup(t);
  const started = await manager.spawn('worker', defaultRoles.worker, cwd, 'REMEMBER alpha');
  const first = await release(manager, started.id);
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

test('task history records every assignment an instance handled, with its outcome', { timeout: 30_000 }, async t => {
  const { cwd, manager } = setup(t);
  const started = await manager.spawn('worker', defaultRoles.worker, cwd, 'REMEMBER first-assignment');
  const first = manager.get(started.id);
  assert.equal(first.runCount, 1);
  assert.equal(first.history.length, 1);
  assert.equal(first.history[0].task, 'REMEMBER first-assignment');
  assert.equal(first.history[0].runId, first.runId);
  assert.equal(typeof first.history[0].startedAt, 'number');
  await complete(manager, started.id);
  assert.equal(manager.get(started.id).history[0].status, 'completed');

  await manager.send(started.id, 'RECALL second-assignment');
  const second = await complete(manager, started.id);
  assert.equal(second.runCount, 2);
  assert.deepEqual(second.history.map(run => run.task), ['REMEMBER first-assignment', 'RECALL second-assignment']);
  assert.deepEqual(second.history.map(run => run.status), ['completed', 'completed']);
  assert.equal(second.task, 'RECALL second-assignment', 'task stays the current assignment');
  assert.equal(second.history.at(-1).runId, second.runId);
  assert.equal(second.logFile, first.logFile, 'idle continuation appends to the original runtime log');
  assert.deepEqual(manager.eventLogs(started.id), [first.logFile],
    'shared runtime logs must be enumerated once rather than duplicated for each run');
});

test('history keeps the five most recent runs and never invents an outcome', { timeout: 20_000 }, async t => {
  const { cwd, manager } = setup(t);
  const started = await manager.spawn('worker', defaultRoles.worker, cwd, 'run-1');
  const first = await release(manager, started.id);
  const dir = path.join(manager.root, started.id);
  // Add historical records only after release, including a crashed run without a report.
  for (let index = 2; index <= 6; index++) {
    const runId = randomUUID();
    writeJson(path.join(dir, 'runs', runId, 'request.json'), { runId, message: `run-${index}`, createdAt: first.startedAt + index });
    if (index !== 6) writeJson(path.join(dir, 'reports', `${runId}-result.json`), {
      notificationId: `${runId}-result`, agentId: started.id, runId, parentFile: manager.parentFile,
      status: 'failed', time: Date.now(), text: '', error: 'boom', logFile: 'events.jsonl',
    });
  }
  // Use a real acknowledged run and owner rather than fabricating a live state.json.
  await manager.send(started.id, 'HOLD run-7');
  const view = manager.get(started.id);
  assert.equal(view.runCount, 7);
  assert.deepEqual(view.history.map(run => run.task), ['run-3', 'run-4', 'run-5', 'run-6', 'HOLD run-7']);
  assert.deepEqual(view.history.map(run => run.status), ['failed', 'failed', 'failed', 'unknown', 'running'],
    'a run without a report has no verdict; the current run reports its live phase');
  assert.equal(view.task, 'HOLD run-7', 'the current assignment is the acknowledged run');
});

test('a queued resume is not shown until the worker acknowledges it', { timeout: 20_000 }, async t => {
  const { cwd, manager } = setup(t);
  const started = await manager.spawn('worker', defaultRoles.worker, cwd, 'REMEMBER before-queue');
  await release(manager, started.id);
  const settled = manager.get(started.id);
  // A resume persists its run directory immediately but the worker only later replaces state.json.
  const queued = randomUUID();
  writeJson(path.join(manager.root, started.id, 'runs', queued, 'request.json'),
    { runId: queued, message: 'queued follow-up', createdAt: Date.now() + 1000 });
  const view = manager.get(started.id);
  assert.equal(view.runId, settled.runId, 'the acknowledged run stays current until the worker takes over');
  assert.equal(view.runCount, 1, 'run count must not count a run the state has not acknowledged');
  assert.equal(view.task, 'REMEMBER before-queue');
  assert.equal(view.history.at(-1).status, 'completed', 'the last acknowledged run keeps its own outcome');
  assert.ok(!view.history.some((run) => run.task === 'queued follow-up'), 'a queued run must not appear as history yet');
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

test('running child inactive for 15 minutes produces one stable, non-terminal alert', { timeout: 20_000 }, async t => {
  const { cwd, manager } = setup(t);
  const start = await manager.spawn('worker', defaultRoles.worker, cwd, 'HOLD');
  const state = await waitUntil('running worker state', () => {
    const published = manager.get(start.id);
    return published.phase === 'running' ? published : undefined;
  }, 10_000);
  // Use the existing snapshot input; backdating the live file races the worker's own writes.
  const inactive = [{ ...state, updatedAt: 1000 }];
  assert.equal(manager.reports(900999, inactive).length, 0);
  const alert = manager.reports(901000, inactive)[0];
  assert.equal(alert.status, 'stalled');
  assert.equal(alert.notificationId, `${state.runId}-inactive`);
  assert.match(alert.text, /15 minutes.*subagent_query/i);
  assert.equal(manager.reports(1000000, inactive)[0].notificationId, alert.notificationId);
  assert.equal(manager.get(start.id).phase, 'running', 'reminder must not stop the worker');
  await manager.send(start.id, 'FINISH');
  const terminal = await complete(manager, start.id);
  assert.ok(manager.reports(1000000, [{ ...terminal, updatedAt: 1000 }]).every(r => r.status !== 'stalled'));
});

test('close stops active work without deleting the resumable session', { timeout: 20_000 }, async t => {
  const { cwd, manager } = setup(t);
  const start = await manager.spawn('worker', defaultRoles.worker, cwd, 'HOLD');
  const stopped = await manager.close(start.id);
  assert.equal(stopped.phase, 'closed'); assert.equal(stopped.lastStatus, 'stopped');
  assert.ok(fs.existsSync(stopped.sessionFile));
  await manager.send(start.id, 'NEW');
  const next = await complete(manager, start.id);
  assert.equal(next.text, 'NEW'); assert.equal(next.sessionId, stopped.sessionId);
});

test('missing sessions, foreign ids and path traversal fail closed', { timeout: 20_000 }, async t => {
  const { cwd, manager, parent } = setup(t);
  const start = await manager.spawn('worker', defaultRoles.worker, cwd, 'DONE');
  const done = await release(manager, start.id);
  fs.renameSync(done.sessionFile, `${done.sessionFile}.backup`);
  await assert.rejects(manager.send(done.id, 'RECALL'), /will not silently create/);
  assert.throws(() => manager.get('../anything'), /Invalid/);
  assert.throws(() => new AgentManager(`${parent}.other`, launch).get(done.id), /does not belong/);
});

test('racing resumes cannot start two CLI owners for the same session', { timeout: 20_000 }, async t => {
  const { cwd, manager, parent } = setup(t);
  const start = await manager.spawn('worker', defaultRoles.worker, cwd, 'DONE');
  await release(manager, start.id);
  const other = new AgentManager(parent, launch);
  const outcomes = await Promise.allSettled([manager.send(start.id, 'HOLD one'), other.send(start.id, 'HOLD two')]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(x => x.status === 'rejected').length, 1);
  const state = manager.get(start.id);
  const lock = readJson(path.join(manager.root, start.id, 'owner.lock'));
  assert.equal(lock.pid, state.workerPid);
});
