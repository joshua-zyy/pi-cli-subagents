import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentManager } from '../dist/manager.js';
import { TranscriptReader } from '../dist/ui/transcript.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJson, waitUntil, processAlive, writeJson } from '../dist/storage.js';
import { tempDir } from './helpers/tmp.mjs';
const fixture = fileURLToPath(new URL('./fixtures/codex.mjs', import.meta.url));
const pi = fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url));
const role = { cli: 'codex', description: 'fixture', instructions: 'Do only this task', model: 'gpt-6-luna', effort: 'medium' };
function setup(t) {
  const cwd = tempDir('codex-manager');
  const home = path.join(cwd, 'home'); fs.mkdirSync(home); fs.writeFileSync(path.join(home, 'fixture-home'), '');
  const parent = path.join(cwd, 'parent.jsonl'); fs.writeFileSync(parent, '{}\n');
  const options = { launch: { command: process.execPath, args: [fixture] }, home };
  const launch = { command: process.execPath, args: [pi] };
  const manager = new AgentManager(parent, launch, options);
  t.after(async () => {
    for (const state of manager.list()) {
      if (processAlive(state.workerPid)) await manager.close(state.id);
      assert.equal(processAlive(manager.get(state.id).workerPid), false);
    }
  });
  const done = (id, phase = 'completed') => waitUntil('Codex worker termination', () => {
    const s = manager.get(id);
    return s.phase === phase && !processAlive(s.workerPid) ? s : undefined;
  }, 12_000);
  return { cwd, home, manager, done, parent, launch, options };
}

test('manager preserves Codex native identity across a fresh controller, old Pi records still resume', { timeout: 30_000 }, async t => {
  const { cwd, home, manager, done, parent, launch, options } = setup(t);
  const started = await manager.spawn('codex-worker', role, cwd, 'REMEMBER alpha');
  const first = await done(started.id);
  assert.equal(first.cli, 'codex'); assert.equal(first.session.cli, 'codex'); assert.equal(first.session.codexHome, home);
  assert.ok(first.session.threadId); assert.notEqual(first.session.threadId, first.sessionId); assert.equal(first.sessionFile, undefined);
  const reopened = new AgentManager(parent, launch, { ...options, home: path.join(cwd, 'different-home') });
  const next = await reopened.send(started.id, 'RECALL');
  const result = await done(next.id);
  assert.equal(result.text, 'alpha'); assert.deepEqual(result.session, first.session); assert.equal(result.runCount, 2);
  assert.equal(manager.reports().filter(r => r.agentId === result.id && r.status === 'completed').length, 2);
  const piStarted = await manager.spawn('worker', { description: 'old Pi', instructions: 'test' }, cwd, 'REMEMBER beta');
  const piFirst = await done(piStarted.id);
  const spec = path.join(manager.root, piStarted.id, 'spec.json');
  const state = path.join(manager.root, piStarted.id, 'state.json');
  const s = readJson(state); delete s.session; writeJson(state, s);
  const resumed = await reopened.send(piStarted.id, 'RECALL');
  assert.equal((await done(resumed.id)).text, 'beta'); assert.equal(reopened.get(resumed.id).sessionId, piFirst.sessionId);
  assert.equal(readJson(spec).cli, undefined);
});

test('Codex worker survives its first controller and accepts steer from a reopened controller', { timeout: 20_000 }, async t => {
  const { cwd, manager, done, parent, launch, options } = setup(t);
  const module = new URL('../dist/manager.js', import.meta.url).href;
  const code = `const {AgentManager}=await import(${JSON.stringify(module)}); const m=new AgentManager(${JSON.stringify(parent)},${JSON.stringify(launch)},${JSON.stringify(options)}); const s=await m.spawn('codex-worker',${JSON.stringify(role)},${JSON.stringify(cwd)},'HOLD'); console.log(JSON.stringify({controllerPid:process.pid,...s}));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { timeout: 10_000 });
  const original = JSON.parse(stdout);
  assert.equal(processAlive(original.controllerPid), false);
  assert.equal(processAlive(original.workerPid), true);
  assert.equal(manager.get(original.id).session.threadId, original.session.threadId);
  await manager.send(original.id, 'AFTER-EXIT');
  assert.equal((await done(original.id)).text, 'AFTER-EXIT');
});

test('running Codex steer works and followUp fails without enqueueing or a new run', { timeout: 20_000 }, async t => {
  const { cwd, manager, done, home } = setup(t);
  const started = await manager.spawn('codex-worker', role, cwd, 'HOLD');
  assert.equal(started.phase, 'running');
  await assert.rejects(manager.send(started.id, 'later', 'followUp'), /followUp.*not supported/i);
  await manager.send(started.id, 'STEERED');
  const final = await done(started.id); assert.equal(final.text, 'STEERED'); assert.equal(final.runCount, 1);
  const records = fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.filter(r => r.method === 'turn/start').length, 1);
  assert.equal(records.filter(r => r.method === 'turn/steer').length, 1);
});

test('Codex event logs render a live conversation and tools without changing Pi transcript parsing', { timeout: 20_000 }, async t => {
  const { cwd, manager, done } = setup(t);
  const started = await manager.spawn('codex-worker', role, cwd, 'TRANSCRIPT');
  const final = await done(started.id);
  const reader = new TranscriptReader('codex', final.session.threadId);
  let snapshot;
  do { snapshot = await reader.read(manager.eventLogs(started.id)); } while (snapshot.loading);
  assert.equal(snapshot.model, 'gpt-6-luna');
  assert.equal(snapshot.entries.find(e => e.kind === 'user')?.text, 'TRANSCRIPT');
  assert.equal(snapshot.entries.find(e => e.kind === 'assistant')?.text, 'TRANSCRIPT-OK');
  assert.equal(snapshot.entries.filter(e => e.kind === 'tool').length, 1);
  assert.equal(snapshot.entries.find(e => e.kind === 'tool').status, 'done');
  assert.equal(snapshot.usage.input, 70); assert.equal(snapshot.usage.cacheRead, 30); assert.equal(snapshot.usage.output, 5);
});

test('Codex approval is visible to the parent and one reasoned decision is audited', { timeout: 20_000 }, async t => {
  const { cwd, manager, done, home } = setup(t);
  const started = await manager.spawn('codex-worker', role, cwd, 'APPROVAL');
  const waiting = await waitUntil('Codex request', () => manager.get(started.id).phase === 'waiting' ? manager.get(started.id) : undefined);
  assert.equal(waiting.questions.length, 1); assert.match(waiting.questions[0].message, /Command: write fixture-only/);
  assert.equal(manager.reports().find(r => r.status === 'waiting')?.questionId, waiting.questions[0].id);
  await assert.rejects(manager.send(started.id, 'yes'), /unresolved interaction/);
  await manager.reply(started.id, waiting.questions[0].id, { confirmed: true }, { actor: 'parent', reason: 'User approved this single fixture action' });
  const final = await done(started.id); assert.equal(final.text, 'ALLOW'); assert.deepEqual(final.questions, []);
  const audit = fs.readFileSync(path.join(manager.root, started.id, 'runs', final.runId, 'permissions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(audit.length, 1); assert.equal(audit[0].decision, 'approved'); assert.equal(audit[0].actor, 'parent');
  assert.equal(audit[0].reason, 'User approved this single fixture action');
  assert.ok(manager.reports().every(r => r.status !== 'waiting'));
  const requests = fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(requests.filter(r => !r.method && r.result?.decision === 'accept').length, 1);
  await assert.rejects(manager.reply(started.id, waiting.questions[0].id, { confirmed: true }), /exited|ended/);
});

test('Codex accept/cancel-only choices route through the worker and record the exact selection', { timeout: 20_000 }, async t => {
  const { cwd, manager, done, home } = setup(t);
  for (const [value, phase] of [['Approve once', 'completed'], ['Cancel turn', 'stopped']]) {
    const started = await manager.spawn('codex-worker', role, cwd, 'APPROVAL_ACCEPT_CANCEL');
    const waiting = await waitUntil('native approval or failure', () => {
      const state = manager.get(started.id); return ['waiting', 'failed', 'stopped', 'completed'].includes(state.phase) ? state : undefined;
    });
    assert.equal(waiting.phase, 'waiting');
    const q = waiting.questions[0]; assert.equal(q.method, 'select'); assert.deepEqual(q.options, ['Approve once', 'Cancel turn']);
    await assert.rejects(manager.reply(started.id, q.id, { confirmed: false }), /Response type/);
    await assert.rejects(manager.reply(started.id, q.id, { value: 'acceptForSession' }), /available options/);
    await manager.reply(started.id, q.id, { value }, { actor: 'parent', reason: 'Only this explicit fixture choice is authorized.' });
    const final = await done(started.id, phase);
    const audit = fs.readFileSync(path.join(manager.root, final.id, 'runs', final.runId, 'permissions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(audit.length, 1); assert.equal(audit[0].selectedOption, value);
    assert.equal(final.questions.length, 0);
  }
  const decisions = fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(r => !r.method);
  assert.deepEqual(decisions.map(r => r.result.decision), ['accept', 'cancel']);
});

test('Codex cancelled/auto-resolved interactions do not remain answerable', { timeout: 20_000 }, async t => {
  const { cwd, manager, done } = setup(t);
  const cancelled = await manager.spawn('codex-worker', role, cwd, 'APPROVAL_FILE');
  const pending = await waitUntil('file request', () => manager.get(cancelled.id).questions[0]);
  assert.match(pending.message, /File changes:/);
  await manager.reply(cancelled.id, pending.id, { cancelled: true }, { actor: 'human' });
  assert.equal((await done(cancelled.id, 'stopped')).text, 'CANCELLED');
  const automatic = await manager.spawn('codex-worker', role, cwd, 'APPROVAL_AUTO_RESOLVE');
  await done(automatic.id);
  assert.equal(manager.get(automatic.id).questions.length, 0);
  assert.ok(manager.reports().every(r => r.status !== 'waiting'));
});

test('Codex rejects invalid workspace and missing model before creating instances', async t => {
  const { cwd, manager } = setup(t);
  await assert.rejects(manager.spawn('codex-worker', role, cwd, 'DO', 'any-workspace'), /Invalid workspace/);
  await assert.rejects(manager.spawn('codex-worker', { ...role, model: undefined }, cwd, 'DO'), /explicit model/);
  assert.deepEqual(manager.list(), []);
});

test('Codex CLI resolution failure leaves existing instances and reports usable', { skip: process.platform !== 'win32', timeout: 20_000 }, async t => {
  const { cwd, parent, manager, launch, done } = setup(t);
  const started = await manager.spawn('worker', { description: 'Pi fixture', instructions: 'test' }, cwd, 'REMEMBER retained');
  const original = await done(started.id);
  const before = fs.readdirSync(manager.root).sort();
  const unresolved = new AgentManager(parent, launch);
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = path.join(cwd, 'no-cli');
    await assert.rejects(unresolved.spawn('codex-worker', role, cwd, 'MUST NOT START'), /Codex CLI is not installed/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  assert.deepEqual(fs.readdirSync(manager.root).sort(), before, 'failed launch resolution must not register an incomplete instance');
  assert.deepEqual(unresolved.list().map(state => state.id), [original.id]);
  assert.equal(unresolved.get(original.id).sessionId, original.sessionId);
  assert.equal(unresolved.reports().find(report => report.agentId === original.id)?.status, 'completed');
});

test('resume refuses a lost native Codex thread and does not create a replacement', { timeout: 20_000 }, async t => {
  const { cwd, manager, done, home } = setup(t);
  const started = await manager.spawn('codex-worker', role, cwd, 'REMEMBER alpha');
  const first = await done(started.id);
  fs.renameSync(path.join(home, `${first.session.threadId}.json`), path.join(home, 'removed.json'));
  const failed = await manager.send(first.id, 'RECALL');
  assert.equal(failed.phase, 'failed'); assert.match(failed.error, /Original thread missing/);
  const records = fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.filter(r => r.method === 'thread/start').length, 1);
  assert.equal(records.filter(r => r.method === 'turn/start').length, 1);
  const failedFinal = await done(first.id, 'failed');
  assert.deepEqual(failedFinal.session, first.session, 'a failed resume must retain the original native handle');
  fs.renameSync(path.join(home, 'removed.json'), path.join(home, `${first.session.threadId}.json`));
  const continued = await manager.send(first.id, 'RECALL');
  assert.equal((await done(continued.id)).text, 'alpha');
  assert.deepEqual(manager.get(first.id).session, first.session);
});
