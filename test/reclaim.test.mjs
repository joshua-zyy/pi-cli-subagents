import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { AgentManager, countsAsActive, occupiesRuntime } from '../dist/manager.js';
import { readJson, writeJson } from '../dist/storage.js';
import { tempDir } from './helpers/tmp.mjs';

const launch = { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url))] };
const role = { description: 'test', instructions: 'test' };

/** A pid the OS has already reaped: ESRCH is the only answer, so absence is real evidence. */
function gonePid() {
  const result = spawnSync(process.execPath, ['-e', '']);
  assert.equal(result.status, 0);
  return result.pid;
}

function liveProcess() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  return child;
}

function setup(t, env = {}) {
  const cwd = tempDir('reclaim');
  const saved = {};
  for (const [key, value] of Object.entries(env)) { saved[key] = process.env[key]; process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const m = new AgentManager(path.join(cwd, 'parent.jsonl'), launch);
  return { cwd, m };
}

/** A template spec copied from a real instance, so synthetic records validate like production ones. */
async function specTemplate(m, cwd) {
  const base = await m.spawn('worker', role, cwd, 'TEMPLATE');
  await m.close(base.id);
  return readJson(path.join(m.root, base.id, 'spec.json'));
}

/** Synthetic v2 instance: the two pids and the lock are the only inputs the reclaim path observes. */
function instance(m, spec, options = {}) {
  const id = randomUUID(), dir = path.join(m.root, id);
  writeJson(path.join(dir, 'spec.json'), { ...spec, id });
  const state = {
    id, runId: randomUUID(), runtimeId: randomUUID(), protocolVersion: 2, phase: 'running',
    workerPid: gonePid(), cliPid: gonePid(), startedAt: Date.now() - 1000, updatedAt: Date.now(),
    accepted: true, questions: [], logFile: path.join(dir, 'runs', randomUUID(), 'events.jsonl'),
    ...options.state,
  };
  if (options.dropCliPid) delete state.cliPid;
  writeJson(path.join(dir, 'state.json'), state);
  if (options.owner !== undefined) writeJson(path.join(dir, 'owner.lock'), options.owner);
  return { id, dir, state };
}

const reclaimFile = (dir, runtimeId) => path.join(dir, 'reclaims', `${runtimeId}.json`);

test('reclaim frees both dimensions once the worker and CLI are gone, and leaves state and lock alone', { timeout: 30000 }, async t => {
  const { cwd, m } = setup(t, { PI_CLI_SUBAGENTS_MAX_RESIDENT: '1', PI_CLI_SUBAGENTS_MAX_ACTIVE: '1' });
  const spec = await specTemplate(m, cwd);
  const target = instance(m, spec);
  const stateFile = path.join(target.dir, 'state.json'), before = fs.readFileSync(stateFile, 'utf8');

  const blocked = m.get(target.id);
  assert.equal(blocked.phase, 'unreachable');
  assert.equal(occupiesRuntime(blocked), true, 'an unreachable runtime still occupies while its processes may exist');
  await assert.rejects(m.spawn('worker', role, cwd, 'MUST NOT START'), /managed runtimes are already occupied/,
    'the cap must count the unreachable runtime before any reclaim');

  const reclaimed = await m.reclaim(target.id, target.state.runtimeId);
  assert.equal(reclaimed.receipt.operation, 'reclaim');
  assert.equal(reclaimed.receipt.status, 'reclaimed');
  assert.deepEqual(reclaimed.receipt.accounting, { active: false, resident: false });
  assert.equal(reclaimed.receipt.nativeReleaseConfirmed, false);
  assert.equal(reclaimed.receipt.continuation, 'blocked');
  assert.deepEqual(reclaimed.receipt.evidence.worker, { pid: target.state.workerPid, absent: true, criterion: 'ESRCH' });
  assert.deepEqual(reclaimed.receipt.evidence.cli, { pid: target.state.cliPid, absent: true, criterion: 'ESRCH' });
  assert.equal(reclaimed.phase, 'unreachable', 'a reclaim never synthesizes a closed runtime');
  assert.equal(occupiesRuntime(m.get(target.id)), false);
  assert.equal(countsAsActive(m.get(target.id)), false);

  assert.equal(fs.readFileSync(stateFile, 'utf8'), before, 'execution state is never rewritten by a reclaim');
  assert.equal(fs.existsSync(path.join(target.dir, 'owner.lock')), false, 'a reclaim never creates a lock');

  const started = await m.spawn('worker', role, cwd, 'AFTER RECLAIM');
  assert(['starting', 'running'].includes(started.phase), `unexpected phase ${started.phase}`);
  await m.close(started.id);
});

test('a matching stale lock does not block reclaim; a conflicting one does', { timeout: 20000 }, async t => {
  const { cwd, m } = setup(t);
  const spec = await specTemplate(m, cwd);
  const matching = instance(m, spec, { owner: null });
  writeJson(path.join(matching.dir, 'owner.lock'), { pid: matching.state.workerPid, runId: matching.state.runId, runtimeId: matching.state.runtimeId });
  const reclaimed = await m.reclaim(matching.id, matching.state.runtimeId);
  assert.equal(reclaimed.receipt.status, 'reclaimed');

  const other = instance(m, spec);
  writeJson(path.join(other.dir, 'owner.lock'), { pid: other.state.workerPid, runId: other.state.runId, runtimeId: randomUUID() });
  const conflict = m.get(other.id);
  assert.equal(conflict.phase, 'unreachable');
  assert.match(conflict.error, /ownership is uncertain/);
  await assert.rejects(m.reclaim(other.id, other.state.runtimeId), /Owner conflict/);
  assert.equal(fs.existsSync(reclaimFile(other.dir, other.state.runtimeId)), false, 'a refusal writes no claim');
  assert.equal(occupiesRuntime(m.get(other.id)), true, 'an ownership conflict keeps occupying both dimensions');
});

test('a live or unverifiable process is never read as absent', { timeout: 20000 }, async t => {
  const { cwd, m } = setup(t);
  const spec = await specTemplate(m, cwd);
  const cli = liveProcess();
  t.after(() => cli.kill());
  const workerGone = instance(m, spec, { state: { cliPid: cli.pid } });
  await assert.rejects(m.reclaim(workerGone.id, workerGone.state.runtimeId), /CLI PID \d+ still exists/);
  assert.equal(fs.existsSync(reclaimFile(workerGone.dir, workerGone.state.runtimeId)), false);

  const cliGone = instance(m, spec, { state: { workerPid: process.pid } });
  await assert.rejects(m.reclaim(cliGone.id, cliGone.state.runtimeId), /Worker PID \d+ still exists/);

  const noCli = instance(m, spec, { dropCliPid: true });
  await assert.rejects(m.reclaim(noCli.id, noCli.state.runtimeId), /records no usable CLI PID/);

  const zeroCli = instance(m, spec, { state: { cliPid: 0 } });
  await assert.rejects(m.reclaim(zeroCli.id, zeroCli.state.runtimeId), /records no usable CLI PID/);

  // Unknown is not absent: a process-existence query that fails must not free a slot.
  const unqueryable = instance(m, spec, { state: { workerPid: 2147483646 } });
  const original = process.kill;
  process.kill = () => { const error = new Error('EPERM'); error.code = 'EPERM'; throw error; };
  t.after(() => { process.kill = original; });
  await assert.rejects(m.reclaim(unqueryable.id, unqueryable.state.runtimeId), /could not be verified/);
  assert.equal(occupiesRuntime(m.get(unqueryable.id)), true);
});

test('a claim names one runtime: a later runtime is counted again', { timeout: 20000 }, async t => {
  const { cwd, m } = setup(t);
  const spec = await specTemplate(m, cwd);
  const target = instance(m, spec);
  await m.reclaim(target.id, target.state.runtimeId);
  assert.equal(occupiesRuntime(m.get(target.id)), false);

  const later = randomUUID();
  writeJson(path.join(target.dir, 'state.json'), { ...target.state, runtimeId: later, runId: randomUUID(), updatedAt: Date.now() });
  const next = m.get(target.id);
  assert.equal(next.runtimeId, later);
  assert.equal(next.reclaimed, undefined, 'the old claim must not describe a newer runtime');
  assert.equal(occupiesRuntime(next), true);

  await assert.rejects(m.reclaim(target.id, target.state.runtimeId), /is not the runtime recorded/,
    'an explicit runtime target binds the claim: retrying with the old id cannot move to the newer runtime');
});

test('only the claim for the current runtime counts; another runtime\'s file frees nothing', { timeout: 20000 }, async t => {
  const { cwd, m } = setup(t);
  const spec = await specTemplate(m, cwd);
  const target = instance(m, spec);
  const foreign = randomUUID();
  writeJson(reclaimFile(target.dir, foreign), {
    version: 1, parentFile: m.parentFile, id: target.id, runtimeId: foreign, observedAt: Date.now(),
    evidence: { worker: { pid: 1, absent: true, criterion: 'ESRCH' }, cli: { pid: 2, absent: true, criterion: 'ESRCH' } },
    nativeReleaseConfirmed: false, continuation: 'blocked',
  });
  const view = m.get(target.id);
  assert.equal(view.reclaimed, undefined, 'a file for another runtime must not mark this one reclaimed');
  assert.equal(occupiesRuntime(view), true);
});

test('reclaim is idempotent and keeps the first evidence', { timeout: 20000 }, async t => {
  const { cwd, m } = setup(t);
  const spec = await specTemplate(m, cwd);
  const target = instance(m, spec);
  const first = await m.reclaim(target.id, target.state.runtimeId);
  const file = reclaimFile(target.dir, target.state.runtimeId), bytes = fs.readFileSync(file, 'utf8');
  const second = await m.reclaim(target.id, target.state.runtimeId);
  assert.equal(second.receipt.status, 'reclaimed');
  assert.equal(second.receipt.evidence.worker.pid, first.receipt.evidence.worker.pid);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'a repeated reclaim never rewrites the observation');
});

test('a damaged claim is ignored instead of making the instance unreadable', { timeout: 20000 }, async t => {
  const { cwd, m } = setup(t);
  const spec = await specTemplate(m, cwd);
  const target = instance(m, spec);
  fs.mkdirSync(path.join(target.dir, 'reclaims'), { recursive: true });
  fs.writeFileSync(reclaimFile(target.dir, target.state.runtimeId), '{"version":1,');
  const view = m.get(target.id);
  assert.equal(view.phase, 'unreachable');
  assert.equal(view.reclaimed, undefined);
  assert.equal(occupiesRuntime(view), true);

  // Structurally plausible but not an absence observation: it must not free a slot either.
  writeJson(reclaimFile(target.dir, target.state.runtimeId), {
    version: 1, parentFile: m.parentFile, id: target.id, runtimeId: target.state.runtimeId, observedAt: Date.now(),
    evidence: { worker: { pid: target.state.workerPid, absent: true, criterion: 'ASSUMED' },
      cli: { pid: target.state.cliPid, absent: true, criterion: 'ESRCH' } },
    nativeReleaseConfirmed: false, continuation: 'blocked',
  });
  const weak = m.get(target.id);
  assert.equal(weak.reclaimed, undefined, 'only an explicit ESRCH observation counts as absence');
  assert.equal(occupiesRuntime(weak), true);
});

test('a claim stops counting only while ownership is absent or the same runtime', { timeout: 20000 }, async t => {
  const { cwd, m } = setup(t);
  const spec = await specTemplate(m, cwd);
  const target = instance(m, spec);
  await m.reclaim(target.id, target.state.runtimeId);
  assert.equal(occupiesRuntime(m.get(target.id)), false);

  // A different owner appears after the claim: the freed slot must come back, because the claim
  // spoke about a runtime whose ownership is no longer confirmed.
  writeJson(path.join(target.dir, 'owner.lock'), { pid: target.state.workerPid, runId: target.state.runId, runtimeId: randomUUID() });
  const conflict = m.get(target.id);
  assert.match(conflict.error, /ownership is uncertain/);
  assert.equal(conflict.reclaimed, undefined, 'a claim cannot hide an ownership conflict');
  assert.equal(occupiesRuntime(conflict), true);
});

test('stop reports that a reclaimed runtime has no native release to confirm', { timeout: 20000 }, async t => {
  const { cwd, m } = setup(t);
  const spec = await specTemplate(m, cwd);
  const target = instance(m, spec);
  await m.reclaim(target.id, target.state.runtimeId);
  await assert.rejects(m.close(target.id), /reclaimed without a native release confirmation/);
});

test('a reclaimed runtime is not resumable, and a new reservation still counts', { timeout: 20000 }, async t => {
  const { cwd, m } = setup(t, { PI_CLI_SUBAGENTS_MAX_RESIDENT: '1', PI_CLI_SUBAGENTS_MAX_ACTIVE: '1' });
  const spec = await specTemplate(m, cwd);
  const target = instance(m, spec);
  await m.reclaim(target.id, target.state.runtimeId);
  await assert.rejects(m.send(target.id, 'RESUME ME'), /uncertain|ownership/i,
    'the reclaimed instance stays unreachable: a claim frees accounting, not the session');

  const resident = await m.spawn('worker', role, cwd, 'RESIDENT');
  await assert.rejects(m.spawn('worker', role, cwd, 'SECOND'), /managed runtimes are already occupied/,
    'a new runtime still occupies its slot after a reclaim');
  await m.close(resident.id);
});
