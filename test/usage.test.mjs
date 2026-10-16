import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import extension from '../dist/index.js';
import { AgentManager } from '../dist/manager.js';
import { WorkspaceStore } from '../dist/workspace.js';
import { projectUsage } from '../dist/usage.js';
import { tempDir } from './helpers/tmp.mjs';

function harness() {
  const tools = new Map();
  extension({ on() {}, registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {} });
  const ctx = { cwd: process.cwd(), isProjectTrusted: () => false, sessionManager: { getSessionFile: () => '/fixture/parent.jsonl' } };
  return { tools, ctx, invoke: (name, args) => tools.get(name).execute('contract', args, undefined, undefined, ctx) };
}
const totals = (cost = 0) => ({ input: 10, output: 2, cacheRead: 20, cacheWrite: 3, cost });
const complete = (cost = 0) => ({ entries: [], loading: false, usageComplete: true, usage: totals(cost) });

test('usage projection omits placeholder costs and never shows incomplete totals', () => {
  assert.deepEqual(projectUsage(complete(0.01), 'claude', '2026-01-02T03:04:05.000Z'), { usageComplete: true, usage:
    { input: 10, output: 2, cacheRead: 20, cacheWrite: 3, cost: 0.01, scope: 'session', asOf: '2026-01-02T03:04:05.000Z' } });
  assert.equal(projectUsage(complete(0), 'claude').usage.cost, 0, 'a real zero cost stays reported');
  assert.equal(Object.hasOwn(projectUsage(complete(0), 'codex').usage, 'cost'), false, 'a codex placeholder cost must not read as free');
  assert.equal(Object.hasOwn(projectUsage(complete(0), 'pi').usage, 'cost'), false);
  assert.equal(projectUsage(complete(0.02), 'pi').usage.cost, 0.02);
  assert.deepEqual(projectUsage({ entries: [], loading: false, usageComplete: false }, 'claude'), { usageComplete: false });
  // A partial parse may carry numbers internally; they must never surface as session totals.
  assert.deepEqual(projectUsage({ entries: [], loading: false, usageComplete: false, usage: totals(1) }, 'pi'), { usageComplete: false });
});

test('get reports the child own reported usage while list and reads stay unchanged', async t => {
  const { invoke } = harness();
  const dir = tempDir('usage-get'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, [
    { type: 'system', subtype: 'init', session_id: 'native', model: 'fixture' },
    { type: 'assistant', session_id: 'native', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    { type: 'assistant', session_id: 'foreign', message: { id: 'x', role: 'assistant', content: [{ type: 'text', text: 'WRONG' }] } },
    { type: 'result', subtype: 'success', is_error: false, session_id: 'native', uuid: 'u1', total_cost_usd: 0.01,
      modelUsage: { model: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 20, cacheCreationInputTokens: 3 } } },
  ].map(JSON.stringify).join('\n') + '\n');
  const before = fs.readFileSync(file);
  const state = { id: 'a', cli: 'claude', runId: 'run', phase: 'completed', text: 'preview', questions: [],
    session: { cli: 'claude', sessionId: 'native' } };
  t.mock.method(AgentManager.prototype, 'list', () => [state]);
  t.mock.method(AgentManager.prototype, 'get', id => { assert.equal(id, 'a'); return state; });
  t.mock.method(AgentManager.prototype, 'eventLogs', id => { assert.equal(id, 'a'); return [file]; });
  t.mock.method(WorkspaceStore.prototype, 'list', async () => []);
  for (const method of ['spawn', 'send', 'close', 'reply', 'interrupt']) t.mock.method(AgentManager.prototype, method, () => { throw Error('query attempted execution'); });
  const json = async args => JSON.parse((await invoke('subagent_query', args)).content[0].text);
  const got = (await json({ action: 'get', id: 'a' })).agents[0];
  assert.equal(got.usageComplete, true);
  const { asOf, ...usage } = got.usage;
  assert.deepEqual(usage, { input: 10, output: 2, cacheRead: 20, cacheWrite: 3, cost: 0.01, scope: 'session' });
  assert.equal(asOf, new Date(fs.statSync(file).mtimeMs).toISOString());
  assert.equal(got.text, 'preview');
  const listed = (await json({ action: 'list' })).agents[0];
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
  const state = { id: 'a', cli: 'codex', phase: 'idle', text: 'preview', questions: [],
    session: { cli: 'codex', threadId: 'thread', sessionId: 's', codexHome: '/fixture' } };
  t.mock.method(AgentManager.prototype, 'get', () => state);
  t.mock.method(AgentManager.prototype, 'eventLogs', () => [file]);
  t.mock.method(WorkspaceStore.prototype, 'list', async () => []);
  const got = JSON.parse((await invoke('subagent_query', { action: 'get', id: 'a' })).content[0].text).agents[0];
  assert.equal(got.usageComplete, true);
  assert.deepEqual(got.usage, { input: 55, output: 7, cacheRead: 40, cacheWrite: 5, scope: 'session', asOf: new Date(fs.statSync(file).mtimeMs).toISOString() });
});

test('get marks a log it cannot read completely as unknown instead of a partial total', async t => {
  const { invoke } = harness();
  const dir = tempDir('usage-big'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'events.jsonl');
  const filler = { type: 'user', session_id: 'native', message: { role: 'user', content: 'x'.repeat(400) } };
  const rows = Array.from({ length: 2500 }, () => filler);
  rows.push({ type: 'result', subtype: 'success', is_error: false, session_id: 'native', uuid: 'u1', total_cost_usd: 9,
    modelUsage: { model: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } });
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
  assert.ok(fs.statSync(file).size > 1024 * 1024, 'the fixture must exceed the bounded window');
  const state = { id: 'a', cli: 'claude', phase: 'completed', text: 'preview', questions: [],
    session: { cli: 'claude', sessionId: 'native' } };
  t.mock.method(AgentManager.prototype, 'get', () => state);
  t.mock.method(AgentManager.prototype, 'eventLogs', () => [file]);
  t.mock.method(WorkspaceStore.prototype, 'list', async () => []);
  const got = JSON.parse((await invoke('subagent_query', { action: 'get', id: 'a' })).content[0].text).agents[0];
  assert.equal(got.usageComplete, false);
  assert.equal(Object.hasOwn(got, 'usage'), false, 'unread history must not be presented as a session total');
});

test('an unreadable log also degrades to unknown rather than failing the query', async t => {
  const { invoke } = harness();
  t.mock.method(AgentManager.prototype, 'get', () => ({ id: 'a', cli: 'pi', phase: 'running', text: 'preview', questions: [] }));
  t.mock.method(AgentManager.prototype, 'eventLogs', () => { throw Error('Invalid or outside-instance runtime log reference'); });
  t.mock.method(WorkspaceStore.prototype, 'list', async () => []);
  const got = JSON.parse((await invoke('subagent_query', { action: 'get', id: 'a' })).content[0].text).agents[0];
  assert.equal(got.usageComplete, false);
  assert.equal(got.text, 'preview');
});
