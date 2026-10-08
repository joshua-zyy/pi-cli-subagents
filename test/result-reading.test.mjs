// Read-side contract fixtures: persisted reports only, no CLI or model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import extension from '../dist/index.js';
import { AgentManager } from '../dist/manager.js';
import { deliverReports } from '../dist/notifier.js';
import { readJson, writeJson } from '../dist/storage.js';
import { tempDir } from './helpers/tmp.mjs';

const evidence = 'VERDICT: BLOCK\nEVIDENCE: src/a.ts:12\nUNVERIFIED: real CLI';
const longText = 'HEAD\n' + 'x'.repeat(13000) + '\nMIDDLE EVIDENCE\n' + '中文🙂\n'.repeat(1800) + '\n' + evidence;
function harness() {
  const cwd = tempDir('result-reading'), parent = path.join(cwd, 'parent.jsonl');
  fs.writeFileSync(parent, '{}\n');
  const manager = new AgentManager(parent, { command: process.execPath, args: [] });
  const tools = new Map(), sent = [], entries = [];
  const ctx = { cwd, isProjectTrusted: () => false, sessionManager: { getSessionFile: () => parent, getEntries: () => entries }, ui: { notify() {}, setStatus() {} } };
  const pi = { on() {}, registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
    sendMessage(message, options) { sent.push({ message, options }); } };
  extension(pi);
  const invoke = async args => JSON.parse((await tools.get('subagent_query').execute('read', args, undefined, undefined, ctx)).content[0].text);
  function add(text = longText, status = 'completed') {
    const id = randomUUID(), dir = path.join(manager.root, id);
    writeJson(path.join(dir, 'spec.json'), { version: 1, id, parentFile: parent, cwd, roleName: 'worker',
      role: { description: 'fixture', instructions: 'test' }, launch: { command: process.execPath, args: [] }, createdAt: 1 });
    const publish = (body, phase = 'completed', time = 1, error) => {
      const runId = randomUUID(), resultFile = path.join(dir, 'reports', `${runId}-result.json`);
      writeJson(path.join(dir, 'runs', runId, 'request.json'), { runId, message: `Task ${time}`, createdAt: time });
      if (body !== undefined) writeJson(resultFile, { notificationId: `${runId}-result`, agentId: id, runId, parentFile: parent,
        status: phase, time, text: body, error, logFile: 'events.jsonl' });
      writeJson(path.join(dir, 'state.json'), { id, runId, phase, workerPid: process.pid, accepted: true, questions: [],
        startedAt: time, updatedAt: time, logFile: 'events.jsonl', ...(body !== undefined ? { resultFile } : {}) });
      return { runId, resultFile };
    };
    return { id, dir, publish, ...publish(text, status) };
  }
  return { cwd, parent, manager, tools, ctx, pi, invoke, add, sent, entries };
}

test('manager → notification preserves the true tail and advertises an exact run result', async () => {
  const h = harness(), a = h.add();
  assert.equal(h.manager.get(a.id).text.length, 12000, 'live views keep their bounded cache');
  deliverReports(h.manager, h.pi, h.ctx, new Set(), 10000);
  const content = h.sent[0].message.content;
  assert.ok(content.includes(evidence), 'the preview must use the original tail, not the tail of the cached head');
  assert.ok(content.includes(`… ${longText.length - 5600} characters omitted …`));
  assert.ok(content.length < 6500, 'one report remains a bounded preview');
  const link = content.match(/Read result: subagent_query\((\{[^\n]+\})\)/);
  assert.ok(link, 'every persisted completion provides a machine-readable result locator');
  const params = JSON.parse(link[1]);
  assert.deepEqual(params, { action: 'result', id: a.id, runId: a.runId });
  const page = await h.invoke(params);
  assert.equal(page.runId, a.runId);
  assert.equal(page.totalLength, longText.length);
  assert.equal(page.text, longText.slice(0, 6000));
});

test('inventory omits report bodies while instance details retain a bounded preview and history', async () => {
  const h = harness(), agents = Array.from({ length: 4 }, () => h.add());
  const listed = await h.invoke({ action: 'list' });
  assert.equal(listed.agents.length, 4);
  for (const agent of listed.agents) {
    assert.equal(Object.hasOwn(agent, 'text'), false);
    assert.equal(Object.hasOwn(agent, 'truncated'), false);
    assert.equal(agent.task, 'Task 1'); assert.equal(agent.history.length, 1);
    assert.ok(agent.runId); assert.deepEqual(agent.questions, []);
  }
  assert.ok(JSON.stringify(listed).length < 6000);
  const detail = (await h.invoke({ action: 'get', id: agents[0].id })).agents[0];
  assert.equal(detail.text, longText.slice(0, 12000)); assert.equal(detail.truncated, true);
  assert.equal(h.tools.size, 4, 'reading results does not add a tool');
});

test('result pages reconstruct every character, including middle evidence and split Unicode', async () => {
  const h = harness(), a = h.add();
  let offset = 0, reconstructed = '', pages = 0;
  do {
    const page = await h.invoke({ action: 'result', id: a.id, runId: a.runId, offset, limit: 2999 });
    assert.equal(page.agentId, a.id); assert.equal(page.runId, a.runId);
    assert.equal(page.status, 'completed'); assert.equal(page.offset, offset);
    assert.equal(page.totalLength, longText.length); assert.ok(page.text.length <= 2999);
    reconstructed += page.text;
    if (pages === 0) a.publish('A newer result must not replace the remaining pages', 'completed', 2);
    if (page.nextOffset !== null) assert.equal(page.nextOffset, offset + page.text.length);
    offset = page.nextOffset;
    assert.ok(++pages < 20, 'paging must terminate');
  } while (offset !== null);
  assert.equal(reconstructed, longText);
  const end = await h.invoke({ action: 'result', id: a.id, runId: a.runId, offset: longText.length });
  assert.equal(end.text, ''); assert.equal(end.nextOffset, null);
});

test('a notification still reads its original run after continuation, without requiring live state', async () => {
  const h = harness(), a = h.add('Original result');
  deliverReports(h.manager, h.pi, h.ctx, new Set(), 10000);
  const link = h.sent[0].message.content.match(/Read result: subagent_query\((\{[^\n]+\})\)/);
  assert.ok(link);
  const original = JSON.parse(link[1]);
  const next = a.publish(undefined, 'running', 2);
  assert.equal((await h.invoke(original)).text, 'Original result');
  await assert.rejects(h.invoke({ action: 'result', id: a.id, runId: next.runId }), /No final result/);
  fs.unlinkSync(path.join(a.dir, 'state.json'));
  assert.equal((await h.invoke(original)).text, 'Original result', 'historical reads do not need a healthy live controller');
});

test('explicit result reads reject missing, foreign and malformed records instead of falling back', async () => {
  const h = harness(), a = h.add(), original = readJson(a.resultFile);
  await assert.rejects(h.invoke({ action: 'result', id: a.id, runId: randomUUID() }), /No final result/);
  await assert.rejects(h.invoke({ action: 'get', id: '' }), /requires id/);
  await assert.rejects(h.invoke({ action: 'result', id: a.id, runId: '../state' }), /Invalid run id/);
  await assert.rejects(h.invoke({ action: 'result', id: '../elsewhere', runId: a.runId }), /Invalid agent id/);
  const other = harness();
  await assert.rejects(other.invoke({ action: 'result', id: a.id, runId: a.runId }), /does not belong/);
  for (const patch of [{ agentId: randomUUID() }, { runId: randomUUID() }, { parentFile: 'foreign' },
    { notificationId: 'different' }, { status: 'waiting' }, { text: 42 }]) {
    writeJson(a.resultFile, { ...original, ...patch });
    await assert.rejects(h.invoke({ action: 'result', id: a.id, runId: a.runId }), /Invalid.*result/);
  }
  fs.writeFileSync(a.resultFile, '{broken');
  await assert.rejects(h.invoke({ action: 'result', id: a.id, runId: a.runId }), error => {
    assert.match(error.message, /Cannot read result/);
    assert.ok(error.message.includes(a.id)); assert.ok(error.message.includes(a.runId));
    return true;
  });
  writeJson(a.resultFile, original);
  fs.unlinkSync(a.resultFile);
  await assert.rejects(h.invoke({ action: 'result', id: a.id, runId: a.runId }), /No final result/);
});

test('result paging validates combinations and bounds at the tool boundary', async () => {
  const h = harness(), a = h.add('small');
  for (const args of [{ action: 'result', runId: a.runId }, { action: 'list', offset: 0 }, { action: 'get', id: a.id, offset: 0 }, { action: 'get', id: a.id, limit: 1 }]) {
    await assert.rejects(h.invoke(args), /requires|require|not allowed/);
  }
  for (const offset of [-1, 0.5, NaN, Infinity, 6]) {
    await assert.rejects(h.invoke({ action: 'result', id: a.id, runId: a.runId, offset }), /offset/);
  }
  for (const limit of [-1, 0, 0.5, NaN, Infinity, 6001]) {
    await assert.rejects(h.invoke({ action: 'result', id: a.id, runId: a.runId, limit }), /limit/);
  }
});

test('empty failed results remain failed, and stopped results remain stopped', async () => {
  const h = harness(), a = h.add('');
  const failed = a.publish('', 'failed', 2, 'Provider interrupted');
  const result = await h.invoke({ action: 'result', id: a.id, runId: failed.runId });
  assert.equal(result.status, 'failed'); assert.equal(result.error, 'Provider interrupted');
  assert.equal(result.text, ''); assert.equal(result.totalLength, 0); assert.equal(result.nextOffset, null);
  const stopped = a.publish('Partial work', 'stopped', 3);
  assert.equal((await h.invoke({ action: 'result', id: a.id, runId: stopped.runId })).status, 'stopped');
});

test('full results are read only for undelivered final notifications, not on every monitor tick', () => {
  const h = harness(), a = h.add();
  const getResult = h.manager.getResult.bind(h.manager), reads = [];
  h.manager.getResult = (id, runId) => { reads.push([id, runId]); return getResult(id, runId); };
  const pending = new Set();
  deliverReports(h.manager, h.pi, h.ctx, pending, 1);
  assert.equal(reads.length, 0, 'the coalescing window does not load full results');
  deliverReports(h.manager, h.pi, h.ctx, pending, 10000);
  assert.deepEqual(reads, [[a.id, a.runId]]);
  deliverReports(h.manager, h.pi, h.ctx, pending, 11000);
  assert.equal(reads.length, 1, 'an enqueued notification does not reread the original');
  h.entries.push({ type: 'custom_message', ...h.sent[0].message });
  deliverReports(h.manager, h.pi, h.ctx, new Set(), 12000);
  assert.equal(reads.length, 1, 'persisted receipts do not reread the original');
  assert.equal(h.manager.get(a.id).text.length, 12000, 'on-demand reads do not replace the bounded cache');
});

test('a failed original-result read does not acknowledge a notification or substitute its cached preview', t => {
  const h = harness(), a = h.add(), diagnostics = [];
  t.mock.method(console, 'error', (...args) => diagnostics.push(args));
  h.manager.list(); // A cached preview exists, but is not a substitute for the original.
  const pending = new Set(), getResult = h.manager.getResult.bind(h.manager);
  h.manager.getResult = () => { throw new Error('Original result unavailable'); };
  deliverReports(h.manager, h.pi, h.ctx, pending, 10000);
  assert.equal(h.sent.length, 0); assert.equal(pending.size, 0);
  for (const text of [a.id, a.runId, 'Original result unavailable']) assert.ok(diagnostics.flat().join(' ').includes(text));
  h.manager.getResult = getResult;
  deliverReports(h.manager, h.pi, h.ctx, pending, 11000);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].message.details.ids, [`${a.runId}-result`]);
});

test('a corrupt old report cannot block healthy runs in its own instance or a sibling, and repair retries its original identity', t => {
  const h = harness(), a = h.add('ORIGINAL EVIDENCE'), b = h.add('SIBLING EVIDENCE'), diagnostics = [];
  t.mock.method(console, 'error', (...args) => diagnostics.push(args));
  const saved = fs.readFileSync(a.resultFile), healthyIds = [`${b.runId}-result`];
  // The damaged run is older than the five-run inventory preview, but still awaiting delivery.
  for (let time = 2; time <= 7; time++) healthyIds.push(`${a.publish(`Healthy later run ${time}`, 'completed', time).runId}-result`);
  const corrupt = Buffer.from('{broken report'); fs.writeFileSync(a.resultFile, corrupt);
  const states = [h.manager.get(a.id), h.manager.get(b.id)], pending = new Set();
  deliverReports(h.manager, h.pi, h.ctx, pending, 10000, states);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].message.details.ids.slice().sort(), healthyIds.sort());
  assert.equal(h.sent[0].message.details.reports.length, healthyIds.length);
  assert.ok(h.sent[0].message.details.reports.every(report => report.status === 'completed'));
  assert.equal(pending.has(`${a.runId}-result`), false, 'a broken report is not a delivered or failed-task receipt');
  assert.deepEqual(fs.readFileSync(a.resultFile), corrupt, 'leave the original evidence for inspection');
  assert.equal(diagnostics.length, 1);
  assert.ok(diagnostics[0].join(' ').includes(a.id)); assert.ok(diagnostics[0].join(' ').includes(a.resultFile));
  assert.ok(diagnostics[0].some(arg => arg instanceof SyntaxError), 'keep the original parsing error');

  h.entries.push({ type: 'custom_message', ...h.sent[0].message });
  fs.writeFileSync(a.resultFile, saved);
  deliverReports(h.manager, h.pi, h.ctx, pending, 11000);
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.sent[1].message.details.ids, [`${a.runId}-result`]);
  assert.match(h.sent[1].message.content, /ORIGINAL EVIDENCE/);
  deliverReports(h.manager, h.pi, h.ctx, pending, 12000);
  assert.equal(h.sent.length, 2, 'healthy and recovered reports retain normal pending deduplication');
});

test('an unreadable report directory is isolated from sibling delivery and retried after repair', t => {
  const h = harness(), a = h.add('RESTORED'), b = h.add('HEALTHY'), diagnostics = [];
  t.mock.method(console, 'error', (...args) => diagnostics.push(args));
  const states = [h.manager.get(a.id), h.manager.get(b.id)];
  const folder = path.dirname(a.resultFile), retained = `${folder}.retained`, pending = new Set();
  fs.renameSync(folder, retained); fs.writeFileSync(folder, 'not a directory');
  try {
    deliverReports(h.manager, h.pi, h.ctx, pending, 10000, states);
    assert.deepEqual(h.sent[0].message.details.ids, [`${b.runId}-result`]);
    assert.equal(pending.has(`${a.runId}-result`), false);
    assert.ok(diagnostics.flat().join(' ').includes(folder));
    assert.ok(diagnostics.flat().join(' ').includes(a.id));
    assert.ok(diagnostics.flat().some(arg => arg?.code === 'ENOTDIR'));
  } finally { fs.unlinkSync(folder); fs.renameSync(retained, folder); }
  h.entries.push({ type: 'custom_message', ...h.sent[0].message });
  deliverReports(h.manager, h.pi, h.ctx, pending, 11000);
  assert.deepEqual(h.sent[1].message.details.ids, [`${a.runId}-result`]);
});

test('corruption between enumeration and full-result reading cannot poison healthy batch content or receipts', t => {
  const h = harness(), a = h.add(), b = h.add('HEALTHY ONLY'), diagnostics = [];
  t.mock.method(console, 'error', (...args) => diagnostics.push(args));
  const saved = fs.readFileSync(a.resultFile), reports = h.manager.reports.bind(h.manager), pending = new Set();
  h.manager.reports = (...args) => {
    const found = reports(...args);
    fs.writeFileSync(a.resultFile, '{changed after enumeration');
    return found;
  };
  deliverReports(h.manager, h.pi, h.ctx, pending, 10000);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].message.details.ids, [`${b.runId}-result`]);
  assert.deepEqual(h.sent[0].message.details.reports, [{ agentId: b.id, status: 'completed' }]);
  assert.deepEqual([...pending], [`${b.runId}-result`]);
  assert.match(h.sent[0].message.content, /HEALTHY ONLY/);
  assert.doesNotMatch(h.sent[0].message.content, /HEAD|MIDDLE EVIDENCE/);
  for (const text of [a.id, a.runId, 'Cannot read result']) assert.ok(diagnostics.flat().join(' ').includes(text));
  assert.equal(fs.readFileSync(a.resultFile, 'utf8'), '{changed after enumeration');

  h.manager.reports = reports; fs.writeFileSync(a.resultFile, saved);
  h.entries.push({ type: 'custom_message', ...h.sent[0].message });
  deliverReports(h.manager, h.pi, h.ctx, pending, 11000);
  assert.deepEqual(h.sent[1].message.details.ids, [`${a.runId}-result`]);
  assert.ok(h.sent[1].message.content.includes(evidence), 'repair recovers the original full result, not its cached head');
});
