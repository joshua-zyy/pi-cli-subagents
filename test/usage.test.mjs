import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import extension from '../dist/index.js';
import { AgentManager } from '../dist/manager.js';
import { WorkspaceStore } from '../dist/workspace.js';
import { projectUsage } from '../dist/usage.js';
import { TranscriptWindow } from '../dist/transcript-window.js';
import { tempDir } from './helpers/tmp.mjs';

function harness() {
  const tools = new Map();
  extension({ on() {}, registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {} });
  const ctx = { cwd: process.cwd(), isProjectTrusted: () => false, sessionManager: { getSessionFile: () => '/fixture/parent.jsonl' } };
  return { tools, ctx, invoke: (name, args) => tools.get(name).execute('contract', args, undefined, undefined, ctx) };
}
const totals = (cost = 0) => ({ input: 10, output: 2, cacheRead: 20, cacheWrite: 3, cost });
const complete = (cost = 0) => ({ entries: [], loading: false, usageComplete: true, usage: totals(cost) });
const claudeState = { id: 'a', cli: 'claude', phase: 'completed', text: 'preview', questions: [],
  session: { cli: 'claude', sessionId: 'native' } };
const get = async (invoke, id = 'a') => JSON.parse((await invoke('subagent_query', { action: 'get', id })).content[0].text).agents[0];

test('usage projection omits placeholder costs and never shows incomplete totals', () => {
  assert.deepEqual(projectUsage(complete(0.01), 'claude'), { usageComplete: true, usage:
    { input: 10, output: 2, cacheRead: 20, cacheWrite: 3, cost: 0.01, scope: 'session' } });
  assert.equal(projectUsage(complete(0), 'claude').usage.cost, 0, 'a real zero cost stays reported');
  assert.equal(Object.hasOwn(projectUsage(complete(0), 'codex').usage, 'cost'), false, 'a codex placeholder cost must not read as free');
  assert.equal(Object.hasOwn(projectUsage(complete(0), 'pi').usage, 'cost'), false);
  assert.equal(projectUsage(complete(0.02), 'pi').usage.cost, 0.02);
  assert.deepEqual(projectUsage({ entries: [], loading: false, usageComplete: false }, 'claude'), { usageComplete: false });
  assert.deepEqual(projectUsage({ entries: [], loading: false, usageComplete: false }, 'claude', 'why not'), { usageComplete: false, usageNote: 'why not' });
  // A partial parse may carry numbers internally; they must never surface as session totals.
  assert.deepEqual(projectUsage({ entries: [], loading: false, usageComplete: false, usage: totals(1) }, 'pi'), { usageComplete: false });
  // A total that silently lacks a counter it never saw is not a session total either.
  const partial = { entries: [], loading: false, usageComplete: true, usage: { ...totals(0), countersIncomplete: true } };
  assert.deepEqual(projectUsage(partial, 'pi', 'partial counters'), { usageComplete: false, usageNote: 'partial counters' });
});

test('get reports the child own reported usage while list and reads stay unchanged', async t => {
  const { invoke } = harness();
  const dir = tempDir('usage-get'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'events.jsonl');
  const result = (session, input, cost) => ({ type: 'result', subtype: 'success', is_error: false, session_id: session, uuid: `u${session}${input}`, total_cost_usd: cost,
    modelUsage: { model: { inputTokens: input, outputTokens: 2, cacheReadInputTokens: 20, cacheCreationInputTokens: 3 } } });
  fs.writeFileSync(file, [
    { type: 'system', subtype: 'init', session_id: 'native', model: 'fixture' },
    { type: 'assistant', session_id: 'native', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    result('native', 10, 0.01),
    // Another session with much larger numbers stands last, where an unfiltered reader would let it win.
    { type: 'assistant', session_id: 'foreign', message: { id: 'x', role: 'assistant', content: [{ type: 'text', text: 'WRONG' }] } },
    result('foreign', 999_999, 42),
  ].map(JSON.stringify).join('\n') + '\n');
  const before = fs.readFileSync(file);
  t.mock.method(AgentManager.prototype, 'get', () => claudeState);
  t.mock.method(AgentManager.prototype, 'list', () => [claudeState]);
  t.mock.method(AgentManager.prototype, 'eventLogs', () => [file]);
  t.mock.method(WorkspaceStore.prototype, 'list', async () => []);
  for (const method of ['spawn', 'send', 'close', 'reply', 'interrupt']) t.mock.method(AgentManager.prototype, method, () => { throw Error('query attempted execution'); });
  const got = await get(invoke);
  assert.equal(got.usageComplete, true);
  assert.deepEqual(got.usage, { input: 10, output: 2, cacheRead: 20, cacheWrite: 3, cost: 0.01, scope: 'session' });
  assert.equal(got.text, 'preview');
  const listed = JSON.parse((await invoke('subagent_query', { action: 'list' })).content[0].text).agents[0];
  assert.equal(Object.hasOwn(listed, 'usage'), false);
  assert.equal(Object.hasOwn(listed, 'usageComplete'), false);
  assert.deepEqual(fs.readFileSync(file), before, 'a query must not write the child log');
  assert.deepEqual(fs.readdirSync(dir), ['events.jsonl'], 'a query must not create files');
});

test('get reports codex session totals without inventing a cost', async t => {
  const { invoke } = harness();
  const dir = tempDir('usage-codex'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, [
    { method: 'thread/tokenUsage/updated', params: { threadId: 'thread', tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 5, outputTokens: 7 } } } },
    { method: 'thread/tokenUsage/updated', params: { threadId: 'other', tokenUsage: { total: { inputTokens: 9999, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 } } } },
  ].map(JSON.stringify).join('\n') + '\n');
  t.mock.method(AgentManager.prototype, 'get', () => ({ ...claudeState, cli: 'codex', session: { cli: 'codex', threadId: 'thread', sessionId: 's', codexHome: '/fixture' } }));
  t.mock.method(AgentManager.prototype, 'eventLogs', () => [file]);
  t.mock.method(WorkspaceStore.prototype, 'list', async () => []);
  const got = await get(invoke);
  assert.equal(got.usageComplete, true);
  assert.deepEqual(got.usage, { input: 55, output: 7, cacheRead: 40, cacheWrite: 5, scope: 'session' });
});

test('get sums what a pi child reported and refuses a breakdown that is not complete', async t => {
  const { invoke } = harness();
  const dir = tempDir('usage-pi'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const message = usage => ({ type: 'message_end', message: { role: 'assistant', content: 'done', provider: 'p', model: 'm', usage } });
  const full = path.join(dir, 'full.jsonl'), partial = path.join(dir, 'partial.jsonl'), tokens = path.join(dir, 'tokens.jsonl');
  fs.writeFileSync(full, [message({ input: 100, output: 20, cacheRead: 900, cacheWrite: 10, totalTokens: 1030, cost: { total: 0.5 } }),
    message({ input: 50, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 55 })].map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(partial, JSON.stringify(message({ input: 10, output: 1, totalTokens: 11 })) + '\n');
  fs.writeFileSync(tokens, JSON.stringify(message({ totalTokens: 12 })) + '\n');
  let files = [full];
  t.mock.method(AgentManager.prototype, 'get', () => ({ ...claudeState, cli: 'pi', session: undefined }));
  t.mock.method(AgentManager.prototype, 'eventLogs', () => files);
  t.mock.method(WorkspaceStore.prototype, 'list', async () => []);
  const complete = await get(invoke);
  assert.equal(complete.usageComplete, true);
  assert.deepEqual(complete.usage, { input: 150, output: 25, cacheRead: 900, cacheWrite: 10, cost: 0.5, scope: 'session' });
  for (const [file, why] of [[partial, 'a counter the CLI never reported must not read as zero'], [tokens, 'totalTokens alone is not a breakdown']]) {
    files = [file];
    const got = await get(invoke);
    assert.equal(got.usageComplete, false, why);
    assert.equal(Object.hasOwn(got, 'usage'), false);
    assert.match(got.usageNote, /complete, usable usage total/);
  }
});

test('a pi total stays unusable when a later message leaves its counters unknown', async t => {
  const { invoke } = harness();
  const dir = tempDir('usage-pi-mixed'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const message = usage => JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: 'done', provider: 'p', model: 'm', usage } });
  const full = { input: 10, output: 1, cacheRead: 5, cacheWrite: 0, totalTokens: 16 };
  const cases = {
    'cost-only.jsonl': [full, { cost: { total: 0.2 } }],
    'negative.jsonl': [full, { ...full, input: -1 }],
    'fractional.jsonl': [full, { ...full, output: 1.5 }],
  };
  t.mock.method(AgentManager.prototype, 'get', () => ({ ...claudeState, cli: 'pi', session: undefined }));
  t.mock.method(WorkspaceStore.prototype, 'list', async () => []);
  for (const [name, rows] of Object.entries(cases)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, rows.map(message).join('\n') + '\n');
    t.mock.method(AgentManager.prototype, 'eventLogs', () => [file]);
    const got = await get(invoke);
    assert.equal(got.usageComplete, false, `${name} must not publish a total`);
    assert.equal(Object.hasOwn(got, 'usage'), false, `${name} must not publish numbers`);
  }
});

test('a later snapshot that cannot be read replaces the earlier totals with unknown', async t => {
  const { invoke } = harness();
  const dir = tempDir('usage-latest'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const claude = path.join(dir, 'claude.jsonl'), codex = path.join(dir, 'codex.jsonl');
  fs.writeFileSync(claude, [
    { type: 'result', subtype: 'success', is_error: false, session_id: 'native', uuid: 'u1', total_cost_usd: 1,
      modelUsage: { model: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } },
    { type: 'result', subtype: 'success', is_error: false, session_id: 'native', uuid: 'u2', total_cost_usd: 2 },
  ].map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(codex, [
    { method: 'thread/tokenUsage/updated', params: { threadId: 'thread', tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 5, outputTokens: 7 } } } },
    { method: 'thread/tokenUsage/updated', params: { threadId: 'thread', tokenUsage: {} } },
  ].map(JSON.stringify).join('\n') + '\n');
  t.mock.method(WorkspaceStore.prototype, 'list', async () => []);
  t.mock.method(AgentManager.prototype, 'get', () => claudeState);
  t.mock.method(AgentManager.prototype, 'eventLogs', () => [claude]);
  const claudeGot = await get(invoke);
  assert.equal(claudeGot.usageComplete, false, 'a result with no cumulative snapshot leaves the total unknown');
  assert.equal(Object.hasOwn(claudeGot, 'usage'), false);
  t.mock.method(AgentManager.prototype, 'get', () => ({ ...claudeState, cli: 'codex', session: { cli: 'codex', threadId: 'thread', sessionId: 's', codexHome: '/fixture' } }));
  t.mock.method(AgentManager.prototype, 'eventLogs', () => [codex]);
  const codexGot = await get(invoke);
  assert.equal(codexGot.usageComplete, false, 'a malformed thread snapshot leaves the total unknown');
  assert.equal(Object.hasOwn(codexGot, 'usage'), false);
});

test('a query walks across runs and does not reread the log it already holds', async t => {
  const { invoke } = harness();
  const dir = tempDir('usage-runs'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = path.join(dir, 'run-1.jsonl'), second = path.join(dir, 'run-2.jsonl'), third = path.join(dir, 'run-3.jsonl');
  fs.writeFileSync(first, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'native', uuid: 'u1', total_cost_usd: 0.01,
    modelUsage: { model: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 20, cacheCreationInputTokens: 3 } } }) + '\n');
  // Two full pages of run logs: walking back steps from one run's offset 0 to the next run's offset 0,
  // which is real progress but not an offset change.
  const filler = JSON.stringify({ type: 'user', session_id: 'native', message: { role: 'user', content: 'x' } });
  const page = filler + ' '.repeat(512 * 1024 - filler.length - 1) + '\n';
  fs.writeFileSync(second, page);
  fs.writeFileSync(third, page);
  t.mock.method(AgentManager.prototype, 'get', () => claudeState);
  t.mock.method(AgentManager.prototype, 'eventLogs', () => [first, second, third]);
  t.mock.method(WorkspaceStore.prototype, 'list', async () => []);
  const reads = [];
  const originalOpen = fsPromises.open;
  fsPromises.open = async (...args) => {
    const handle = await originalOpen(...args);
    const read = handle.read.bind(handle);
    handle.read = async (...input) => { const result = await read(...input); reads.push(result.bytesRead); return result; };
    return handle;
  };
  syncBuiltinESMExports();
  t.after(() => { fsPromises.open = originalOpen; syncBuiltinESMExports(); });
  const cold = await get(invoke);
  assert.equal(cold.usageComplete, true);
  assert.deepEqual(cold.usage, { input: 10, output: 2, cacheRead: 20, cacheWrite: 3, cost: 0.01, scope: 'session' });
  const coldBytes = reads.reduce((sum, value) => sum + value, 0);
  assert.ok(coldBytes > 1024 * 1024, `a cold query must walk back through both pages, read ${coldBytes}`);
  reads.length = 0;
  const warm = await get(invoke);
  assert.deepEqual(warm.usage, cold.usage);
  assert.equal(reads.reduce((sum, value) => sum + value, 0), 0, 'a warm query must not reread retained bytes');
});

test('a query cancelled while walking pages rejects and leaves the instance answerable', async t => {
  const { tools, ctx, invoke } = harness();
  const dir = tempDir('usage-cancel'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'events.jsonl');
  const filler = { type: 'user', session_id: 'native', message: { role: 'user', content: 'x'.repeat(400) } };
  const rows = Array.from({ length: 2500 }, () => filler);
  rows.push({ type: 'result', subtype: 'success', is_error: false, session_id: 'native', uuid: 'u1', total_cost_usd: 0.01,
    modelUsage: { model: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 20, cacheCreationInputTokens: 3 } } });
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
  t.mock.method(AgentManager.prototype, 'get', () => claudeState);
  t.mock.method(AgentManager.prototype, 'eventLogs', () => [file]);
  t.mock.method(WorkspaceStore.prototype, 'list', async () => []);
  const controller = new AbortController();
  const originalPageUp = TranscriptWindow.prototype.pageUp;
  t.mock.method(TranscriptWindow.prototype, 'pageUp', function (files) { controller.abort(); return originalPageUp.call(this, files); });
  await assert.rejects(tools.get('subagent_query').execute('cancelled', { action: 'get', id: 'a' }, controller.signal, undefined, ctx), /abort/i);
  const after = await get(invoke);
  assert.equal(after.usageComplete, true);
  assert.deepEqual(after.usage, { input: 10, output: 2, cacheRead: 20, cacheWrite: 3, cost: 0.01, scope: 'session' });
});

test('a log that vanishes or shrinks while it is read is not reported as a total', async t => {
  const { invoke } = harness();
  const dir = tempDir('usage-change'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'native', uuid: 'u1', total_cost_usd: 0.01,
    modelUsage: { model: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 20, cacheCreationInputTokens: 3 } } }) + '\n');
  t.mock.method(AgentManager.prototype, 'get', () => claudeState);
  t.mock.method(AgentManager.prototype, 'eventLogs', () => [file]);
  t.mock.method(WorkspaceStore.prototype, 'list', async () => []);
  const realStat = fs.statSync;
  let mode = 'vanish', calls = 0;
  const mocked = t.mock.method(fs, 'statSync', (target, ...rest) => {
    if (path.resolve(String(target)) !== path.resolve(file) || ++calls === 1) return realStat(target, ...rest);
    if (mode === 'vanish') { const error = new Error('ENOENT: the log vanished while it was read'); error.code = 'ENOENT'; throw error; }
    const stats = realStat(target, ...rest);
    return { size: stats.size - 1, isFile: () => true };
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  const vanished = await get(invoke);
  assert.equal(vanished.usageComplete, false);
  assert.equal(vanished.usageNote, 'the retained log could not be read');
  calls = 0; mode = 'shrink';
  const shrunk = await get(invoke);
  assert.equal(shrunk.usageComplete, false, 'a log that shrank mid-read cannot prove a session total');
  assert.equal(Object.hasOwn(shrunk, 'usage'), false);
});

test('get walks a bounded log back to its start instead of reporting a partial total', async t => {
  const { invoke } = harness();
  const dir = tempDir('usage-big'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'events.jsonl');
  const filler = { type: 'user', session_id: 'native', message: { role: 'user', content: 'x'.repeat(400) } };
  const rows = Array.from({ length: 2500 }, () => filler);
  rows.push({ type: 'result', subtype: 'success', is_error: false, session_id: 'native', uuid: 'u1', total_cost_usd: 9,
    modelUsage: { model: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } });
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
  assert.ok(fs.statSync(file).size > 1024 * 1024, 'the fixture must exceed the first bounded window');
  t.mock.method(AgentManager.prototype, 'get', () => claudeState);
  t.mock.method(AgentManager.prototype, 'eventLogs', () => [file]);
  t.mock.method(WorkspaceStore.prototype, 'list', async () => []);
  const got = await get(invoke);
  assert.equal(got.usageComplete, true);
  assert.equal(got.usage.input, 10);
  assert.equal(got.usage.cost, 9);
});

test('get marks a log too large for the bounded window as unknown instead of a partial total', async t => {
  const { invoke } = harness();
  const dir = tempDir('usage-huge'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'events.jsonl');
  const filler = JSON.stringify({ type: 'user', session_id: 'native', message: { role: 'user', content: 'x'.repeat(4096) } }) + '\n';
  fs.writeFileSync(file, filler.repeat(1300));
  fs.appendFileSync(file, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'native', uuid: 'u1', total_cost_usd: 9,
    modelUsage: { model: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } }) + '\n');
  assert.ok(fs.statSync(file).size > 4.5 * 1024 * 1024, 'the fixture must exceed the window byte budget');
  t.mock.method(AgentManager.prototype, 'get', () => claudeState);
  t.mock.method(AgentManager.prototype, 'eventLogs', () => [file]);
  t.mock.method(WorkspaceStore.prototype, 'list', async () => []);
  const got = await get(invoke);
  assert.equal(got.usageComplete, false);
  assert.equal(Object.hasOwn(got, 'usage'), false, 'unread history must not be presented as a session total');
  assert.match(got.usageNote, /larger than the bounded transcript window/);
});

test('a missing run log keeps an older run total out of the session answer', async t => {
  const { invoke } = harness();
  const dir = tempDir('usage-missing'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'native', uuid: 'u1', total_cost_usd: 9,
    modelUsage: { model: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } }) + '\n');
  t.mock.method(AgentManager.prototype, 'get', () => claudeState);
  t.mock.method(AgentManager.prototype, 'eventLogs', () => [file, path.join(dir, 'deleted-run.jsonl')]);
  t.mock.method(WorkspaceStore.prototype, 'list', async () => []);
  const got = await get(invoke);
  assert.equal(got.usageComplete, false, 'the newest run is unreadable, so no session total is knowable');
  assert.equal(Object.hasOwn(got, 'usage'), false);
  assert.equal(got.usageNote, 'the retained log could not be read');
  assert.equal(got.text, 'preview');
});

test('a cancelled query rejects instead of answering with a stale total', async t => {
  const { tools, ctx } = harness();
  const dir = tempDir('usage-abort'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'native', uuid: 'u1', total_cost_usd: 1,
    modelUsage: { model: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } }) + '\n');
  t.mock.method(AgentManager.prototype, 'get', () => claudeState);
  t.mock.method(AgentManager.prototype, 'eventLogs', () => [file]);
  t.mock.method(WorkspaceStore.prototype, 'list', async () => []);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(tools.get('subagent_query').execute('cancelled', { action: 'get', id: 'a' }, controller.signal, undefined, ctx), /abort/i);
  // The same instance must still answer normally afterwards.
  const after = JSON.parse((await tools.get('subagent_query').execute('retry', { action: 'get', id: 'a' }, undefined, undefined, ctx)).content[0].text).agents[0];
  assert.equal(after.usageComplete, true);
});

test('an unreadable log also degrades to unknown rather than failing the query', async t => {
  const { invoke } = harness();
  t.mock.method(AgentManager.prototype, 'get', () => ({ id: 'a', cli: 'pi', phase: 'running', text: 'preview', questions: [] }));
  t.mock.method(AgentManager.prototype, 'eventLogs', () => { throw Error('Invalid or outside-instance runtime log reference'); });
  t.mock.method(WorkspaceStore.prototype, 'list', async () => []);
  const got = await get(invoke);
  assert.equal(got.usageComplete, false);
  assert.equal(got.usageNote, 'the retained log could not be read');
  assert.equal(got.text, 'preview');
});

test('repeated gets follow appended and replaced logs instead of a stale cached window', async t => {
  const { invoke } = harness();
  const dir = tempDir('usage-refresh'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'events.jsonl');
  const result = (input, cost) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'native', uuid: `u${input}`, total_cost_usd: cost,
    modelUsage: { model: { inputTokens: input, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } }) + '\n';
  fs.writeFileSync(file, result(10, 0.01));
  let files = [file];
  t.mock.method(AgentManager.prototype, 'get', () => claudeState);
  t.mock.method(AgentManager.prototype, 'eventLogs', () => files);
  t.mock.method(WorkspaceStore.prototype, 'list', async () => []);
  assert.equal((await get(invoke)).usage.input, 10);
  fs.appendFileSync(file, result(30, 0.03));
  assert.equal((await get(invoke)).usage.input, 30, 'appended records must be read, not served from a stale window');
  const replacement = path.join(dir, 'replacement.jsonl');
  fs.writeFileSync(replacement, result(70, 0.07));
  files = [replacement];
  assert.equal((await get(invoke)).usage.input, 70, 'a replaced run log must invalidate the retained window');
});
