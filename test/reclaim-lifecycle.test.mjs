import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { AgentManager, occupiesRuntime } from '../dist/manager.js';
import { processAlive, readJson, writeJson, waitUntil } from '../dist/storage.js';
import { tempDir } from './helpers/tmp.mjs';

const launch = { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url))] };
const role = { description: 'test', instructions: 'test' };

/**
 * Real processes, synthetic record: a runtime whose worker pid is reaped while a *test-owned* live
 * process stands in for the CLI. This proves the OS observation and the admission wiring; it does not
 * prove the product's own worker/CLI orphan lifecycle (see prereg-I0.md A10 note).
 */
test('a live CLI process blocks reclaim until it exits, then the real admission path frees the slot', { timeout: 90000 }, async t => {
  const cwd = tempDir('reclaim-lifecycle');
  const release = (key, value) => { const saved = process.env[key]; process.env[key] = value; t.after(() => { if (saved === undefined) delete process.env[key]; else process.env[key] = saved; }); };
  release('PI_CLI_SUBAGENTS_MAX_RESIDENT', '1');
  release('PI_CLI_SUBAGENTS_MAX_ACTIVE', '1');
  const m = new AgentManager(path.join(cwd, 'parent.jsonl'), launch);

  const base = await m.spawn('worker', role, cwd, 'TEMPLATE');
  await m.close(base.id);
  const spec = readJson(path.join(m.root, base.id, 'spec.json'));

  const cli = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => { try { cli.kill('SIGKILL'); } catch { /* already gone */ } });
  const reapedWorker = spawnSync(process.execPath, ['-e', '']).pid;
  const id = randomUUID(), dir = path.join(m.root, id);
  writeJson(path.join(dir, 'spec.json'), { ...spec, id });
  const runtimeId = randomUUID();
  writeJson(path.join(dir, 'state.json'), {
    id, runId: randomUUID(), runtimeId, protocolVersion: 2, phase: 'running',
    workerPid: reapedWorker, cliPid: cli.pid, startedAt: Date.now() - 1000, updatedAt: Date.now(),
    accepted: true, questions: [], logFile: path.join(dir, 'runs', randomUUID(), 'events.jsonl'),
  });
  writeJson(path.join(dir, 'owner.lock'), { pid: reapedWorker, runId: randomUUID(), runtimeId });
  const stateFile = path.join(dir, 'state.json'), before = fs.readFileSync(stateFile, 'utf8');

  const orphan = m.get(id);
  assert.equal(orphan.phase, 'unreachable');
  assert.equal(occupiesRuntime(orphan), true);
  await assert.rejects(m.spawn('worker', role, cwd, 'CAP MUST HOLD'), /managed runtimes are already occupied/);
  await assert.rejects(m.reclaim(id, runtimeId), /CLI PID \d+ still exists/);
  assert.equal(fs.existsSync(path.join(dir, 'reclaims', `${runtimeId}.json`)), false, 'a refusal writes no claim');

  process.kill(cli.pid, 'SIGKILL');
  await waitUntil('the stand-in CLI exited', () => !processAlive(cli.pid) ? true : undefined, 20000);
  const reclaimed = await m.reclaim(id, runtimeId);
  assert.equal(reclaimed.receipt.status, 'reclaimed');
  assert.equal(reclaimed.receipt.nativeReleaseConfirmed, false);
  assert.equal(reclaimed.receipt.continuation, 'blocked');

  // A second controller reads the same disk: the slot is free, the record and lock are untouched.
  const fresh = new AgentManager(path.join(cwd, 'parent.jsonl'), launch);
  assert.equal(occupiesRuntime(fresh.get(id)), false);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before, 'execution state is not rewritten');
  assert(fs.existsSync(path.join(dir, 'owner.lock')), 'the stale lock is never released by a reclaim');
  await assert.rejects(fresh.send(id, 'RESUME'), /uncertain|ownership/i);

  // The real dispatch path must now pass the cap that refused it before the reclaim.
  const started = await m.spawn('worker', role, cwd, 'AFTER RECLAIM');
  assert(['starting', 'running', 'idle', 'completed'].includes(started.phase), `unexpected phase ${started.phase}`);
  await m.close(started.id);
});
