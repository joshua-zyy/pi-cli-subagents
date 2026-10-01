// Persisted history fixtures only: no native CLI, model, account, or control endpoint.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { AgentManager } from '../dist/manager.js';
import { readJson, writeJson } from '../dist/storage.js';

const output = path.resolve('.test-output'); fs.mkdirSync(output, { recursive: true });
function fixture(count = 100) {
  const cwd = fs.mkdtempSync(path.join(output, 'history-cache-')), parent = path.join(cwd, 'parent.jsonl');
  fs.writeFileSync(parent, '{}\n');
  const manager = new AgentManager(parent, { command: process.execPath, args: [] }), id = randomUUID();
  const dir = path.join(manager.root, id), runs = [];
  writeJson(path.join(dir, 'spec.json'), { version: 1, id, parentFile: parent, cwd, roleName: 'worker',
    role: { description: 'fixture', instructions: 'test' }, launch: { command: process.execPath, args: [] }, createdAt: 1 });
  for (let n = 1; n <= count; n++) {
    const runId = randomUUID(); runs.push(runId);
    writeJson(path.join(dir, 'runs', runId, 'request.json'), { runId, message: `Task ${n} ` + 'x'.repeat(4000), createdAt: n });
    writeJson(path.join(dir, 'reports', `${runId}-result.json`), { notificationId: `${runId}-result`, agentId: id,
      runId, parentFile: parent, status: 'completed', time: n, text: `Result ${n} ` + 'y'.repeat(16000), logFile: 'events.jsonl' });
  }
  const runId = runs.at(-1), stateFile = path.join(dir, 'state.json');
  writeJson(stateFile, { id, runId, phase: 'completed', workerPid: 0, accepted: true, questions: [], startedAt: count,
    updatedAt: count, resultFile: path.join(dir, 'reports', `${runId}-result.json`), logFile: 'events.jsonl' });
  return { manager, id, dir, parent, runs, stateFile };
}
function measure(action) {
  const read = fs.readFileSync, stat = fs.statSync;
  const count = { reads: 0, bytes: 0, stats: 0 };
  fs.readFileSync = function (...args) { const result = read.apply(this, args); count.reads++; count.bytes += Buffer.byteLength(result); return result; };
  fs.statSync = function (...args) { count.stats++; return stat.apply(this, args); };
  syncBuiltinESMExports();
  try { return { result: action(), count }; }
  finally { fs.readFileSync = read; fs.statSync = stat; syncBuiltinESMExports(); }
}

test('unchanged history refresh reuses bounded summaries instead of rereading every JSON file', t => {
  const { manager, id } = fixture();
  const refresh = () => { const agents = manager.list(); return { agents, reports: manager.reports(Date.now(), agents) }; };
  const cold = measure(refresh), warm = measure(refresh);
  t.diagnostic(JSON.stringify({ cold: cold.count, warm: warm.count }));
  assert.ok(warm.count.reads <= 4, `unchanged refresh reread ${warm.count.reads} files`);
  assert.ok(warm.count.bytes < 5000, 'live spec/state remain fresh, but historical payloads are not reread');
  assert.equal(warm.result.reports.length, 100);
  assert.equal(warm.result.agents[0].runCount, 100);
  assert.equal(warm.result.agents[0].history.length, 5);
  assert.equal(warm.result.agents[0].truncated, true, 'memoizing clipped results must not lose the truncation flag');
  assert.equal(warm.result.agents[0].text.length, 12000);
  assert.ok(warm.result.agents[0].history.every(run => run.task.length <= 200));
  warm.result.reports[0].text = 'caller mutation'; warm.result.agents[0].history[0].task = 'caller mutation';
  assert.notEqual(manager.reports()[0].text, 'caller mutation');
  assert.notEqual(manager.get(id).history[0].task, 'caller mutation');
});

test('history memoization sees external publication, replacement, deletion and live permission changes', () => {
  const { manager, id, dir, parent, runs, stateFile } = fixture(3);
  manager.get(id); manager.reports();
  const next = randomUUID(), requestFile = path.join(dir, 'runs', next, 'request.json');
  fs.mkdirSync(path.dirname(requestFile));
  assert.equal(manager.get(id).runCount, 3);
  assert.equal(manager.eventLogs(id).length, 3, 'an unpublished request is not cached as a permanent absence');
  const old = readJson(stateFile);
  const reportFile = path.join(dir, 'reports', `${next}-result.json`);
  const storage = new URL('../dist/storage.js', import.meta.url).href;
  // Another OS process publishes the request and acknowledges it in the live state.
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    const {writeJson}=await import(${JSON.stringify(storage)});
    writeJson(${JSON.stringify(requestFile)}, ${JSON.stringify({ runId: next, message: 'External task' })});
    writeJson(${JSON.stringify(stateFile)}, ${JSON.stringify({ ...old, runId: next, resultFile: undefined, phase: 'waiting', workerPid: process.pid,
      questions: [{ id: 'q1', method: 'confirm', title: 'Allow fixture?' }] })});
    writeJson(${JSON.stringify(reportFile)}, ${JSON.stringify({ notificationId: `${next}-waiting`, agentId: id, runId: next,
      parentFile: parent, status: 'waiting', questionId: 'q1', time: 4, text: 'Allow fixture?', logFile: 'events.jsonl' })});
  `], { windowsHide: true });
  let view = manager.get(id);
  assert.equal(view.runCount, 4); assert.equal(view.task, 'External task');
  assert.ok(Math.abs(view.history.at(-1).startedAt - fs.statSync(requestFile).mtimeMs) < 1, 'legacy timestamps still use file mtime');
  assert.equal(view.phase, 'waiting'); assert.equal(view.questions[0].id, 'q1');
  assert.ok(manager.reports().some(r => r.status === 'waiting'));
  writeJson(stateFile, { ...readJson(stateFile), questions: [], phase: 'running' });
  assert.equal(manager.reports().some(r => r.status === 'waiting'), false, 'cached waiting reports are filtered against live state');
  writeJson(reportFile, { ...readJson(reportFile), notificationId: `${next}-result`, status: 'completed', questionId: undefined,
    text: 'Finished ' + 'z'.repeat(16000) });
  writeJson(stateFile, { ...readJson(stateFile), phase: 'completed', workerPid: 0, resultFile: reportFile });
  view = manager.get(id);
  assert.match(view.text, /^Finished /); assert.equal(view.truncated, true);
  assert.equal(manager.reports().find(r => r.runId === next).status, 'completed', 'replaced reports must invalidate their cached summaries');
  fs.unlinkSync(reportFile);
  assert.equal(manager.get(id).text, undefined, 'deleted reports must not retain a cached result');
  assert.equal(manager.reports().some(r => r.runId === next), false);

  const replace = path.join(dir, 'runs', runs.at(-1), 'request.json'), original = readJson(replace);
  const fixedTime = 1700000000;
  fs.utimesSync(replace, fixedTime, fixedTime); manager.get(id);
  const stamp = fs.statSync(replace, { bigint: true });
  writeJson(replace, { ...original, message: original.message.replace('Task', 'Edit') });
  fs.utimesSync(replace, fixedTime, fixedTime);
  const replaced = fs.statSync(replace, { bigint: true });
  assert.equal(replaced.size, stamp.size); assert.equal(replaced.mtimeNs, stamp.mtimeNs);
  assert.match(manager.get(id).history.find(r => r.runId === runs.at(-1)).task, /^Edit/);
  fs.writeFileSync(replace, fs.readFileSync(replace, 'utf8').replace('Edit', 'Redo'));
  fs.utimesSync(replace, fixedTime, fixedTime);
  const rewritten = fs.statSync(replace, { bigint: true });
  assert.equal(rewritten.ino, replaced.ino); assert.equal(rewritten.size, replaced.size); assert.equal(rewritten.mtimeNs, replaced.mtimeNs);
  assert.notEqual(rewritten.ctimeNs, replaced.ctimeNs);
  assert.match(manager.get(id).history.find(r => r.runId === runs.at(-1)).task, /^Redo/, 'in-place rewrites cannot reuse an old summary');
  fs.writeFileSync(replace, 'broken JSON');
  assert.throws(() => manager.get(id), SyntaxError, 'invalid replacements must not reuse a cached success');
  fs.unlinkSync(replace);
  assert.equal(manager.get(id).runCount, 3);
  assert.equal(manager.eventLogs(id).length, 3);
  const specFile = path.join(dir, 'spec.json'), spec = readJson(specFile);
  writeJson(specFile, { ...spec, parentFile: `${parent}.foreign` });
  assert.throws(() => manager.get(id), /does not belong/, 'ownership checks must never use the historical cache');
});
