import test from 'node:test';
import assert from 'node:assert/strict';
import { validateToolArguments } from '@earendil-works/pi-ai';
import extension from '../dist/index.js';
import { AgentManager } from '../dist/manager.js';
import { WorkspaceStore } from '../dist/workspace.js';

function harness() {
  const tools = new Map();
  extension({ on() {}, registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {} });
  const ctx = { cwd: process.cwd(), isProjectTrusted: () => false, sessionManager: { getSessionFile: () => '/fixture/parent.jsonl' } };
  return { tools, invoke: (name, args) => tools.get(name).execute('contract', args, undefined, undefined, ctx) };
}

test('only four root-object tools are exposed; old command names are not aliases', () => {
  const { tools } = harness();
  assert.deepEqual([...tools.keys()].sort(), ['subagent', 'subagent_query', 'subagent_reply', 'subagent_workspace']);
  for (const tool of tools.values()) {
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.parameters.additionalProperties, false);
    assert.throws(() => validateToolArguments(tool, { id: 'x', name: tool.name, arguments: { unexpected: true } }));
  }
});

test('action validation refuses missing, irrelevant and unknown fields before runtime access', async () => {
  const { invoke } = harness();
  for (const [tool, args, pattern] of [
    ['subagent', {}, /action/],
    ['subagent', { action: 'other' }, /action/],
    ['subagent', { action: 'start', role: 'worker' }, /task/],
    ['subagent', { action: 'start', role: 'worker', task: 'task', id: 'old' }, /id/],
    ['subagent', { action: 'send', id: 'old' }, /message/],
    ['subagent', { action: 'send', id: 'old', message: 'new', role: 'worker' }, /role/],
    ['subagent', { action: 'stop', id: 'old', message: 'new' }, /message/],
    ['subagent_query', { action: 'list', id: 'old' }, /id/],
    ['subagent_query', { action: 'get', id: 'old', runId: 'old-run' }, /runId/],
    ['subagent_query', { action: 'result', id: 'old' }, /runId/],
    ['subagent_query', { action: 'other' }, /action/],
    ['subagent_workspace', { action: 'create', workspace: 'old' }, /workspace/],
    ['subagent_workspace', { action: 'integrate' }, /workspace/],
    ['subagent_workspace', { action: 'integrate', workspace: 'old', includeUncommitted: { reason: 'not applicable' } }, /includeUncommitted/],
    ['subagent_reply', { id: 'old', questionId: 'q', reason: 'reason', confirmed: true, actor: 'human' }, /actor/],
  ]) await assert.rejects(invoke(tool, args), pattern, JSON.stringify({tool, args}));
});

test('the stop and workspace actions retain the existing runtime operation and target', async t => {
  const { invoke } = harness(), calls = [];
  t.mock.method(AgentManager.prototype, 'close', async id => { calls.push(['stop', id]); return { id, phase: 'stopped' }; });
  t.mock.method(WorkspaceStore.prototype, 'create', async (cwd, args) => { calls.push(['create', cwd, args]); return { id: 'workspace' }; });
  t.mock.method(WorkspaceStore.prototype, 'integrate', async id => { calls.push(['integrate', id]); return { workspace: id, status: 'applied' }; });
  await invoke('subagent', { action: 'stop', id: 'original' });
  await invoke('subagent_workspace', { action: 'create', includeUncommitted: { reason: 'explicit authorization' } });
  await invoke('subagent_workspace', { action: 'integrate', workspace: 'workspace' });
  assert.deepEqual(calls, [
    ['stop', 'original'],
    ['create', process.cwd(), { includeUncommitted: { reason: 'explicit authorization' } }],
    ['integrate', 'workspace'],
  ]);
});

test('query actions are read-only projections and result uses exact run identity', async t => {
  const { invoke } = harness(), calls = [];
  const state = { id: 'a', runId: 'new', role: 'custom', phase: 'completed', text: 'preview' };
  t.mock.method(AgentManager.prototype, 'list', () => [state]);
  t.mock.method(AgentManager.prototype, 'get', id => { assert.equal(id, 'a'); return state; });
  t.mock.method(AgentManager.prototype, 'getResult', (id, runId) => { calls.push([id, runId]); return { agentId: id, runId, status: 'completed', text: 'original' }; });
  t.mock.method(WorkspaceStore.prototype, 'list', async () => [{ id: 'workspace' }]);
  for (const method of ['spawn', 'send', 'close', 'reply']) t.mock.method(AgentManager.prototype, method, () => { throw Error('query attempted execution'); });
  const json = async args => JSON.parse((await invoke('subagent_query', args)).content[0].text);
  const listed = await json({ action: 'list' });
  assert.equal(Object.hasOwn(listed.agents[0], 'text'), false);
  assert.deepEqual(listed.workspaces, [{ id: 'workspace' }]);
  assert.equal((await json({ action: 'get', id: 'a' })).agents[0].text, 'preview');
  const page = await json({ action: 'result', id: 'a', runId: 'old', offset: 2, limit: 3 });
  assert.equal(page.text, 'igi'); assert.equal(page.runId, 'old'); assert.equal(page.nextOffset, 5);
  assert.deepEqual(calls, [['a', 'old']]);
});
