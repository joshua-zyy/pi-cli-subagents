import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateToolArguments } from '@earendil-works/pi-ai';
import extension from '../dist/index.js';
import { AgentManager } from '../dist/manager.js';
import { WorkspaceStore } from '../dist/workspace.js';

function harness() {
  const tools = new Map();
  extension({ on() {}, registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {} });
  const ctx = { cwd: process.cwd(), isProjectTrusted: () => false, sessionManager: { getSessionFile: () => '/fixture/parent.jsonl' } };
  return { tools, ctx, invoke: (name, args) => tools.get(name).execute('contract', args, undefined, undefined, ctx) };
}

test('only three root-object tools are exposed; old command names are not aliases', () => {
  const { tools } = harness();
  assert.deepEqual([...tools.keys()].sort(), ['subagent', 'subagent_query', 'subagent_reply']);
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
    ['subagent', { action: 'reclaim', id: 'old' }, /runtimeId/],
    ['subagent', { action: 'reclaim', id: 'old', runtimeId: 'r1', message: 'x' }, /message/],
    ['subagent_query', { action: 'list', id: 'old' }, /id/],
    ['subagent_query', { action: 'get', id: 'old', runId: 'old-run' }, /runId/],
    ['subagent_query', { action: 'result', id: 'old' }, /runId/],
    ['subagent_query', { action: 'activity' }, /id/],
    ['subagent_query', { action: 'activity', id: 'old', runId: 'run' }, /runId/],
    ['subagent_query', { action: 'activity', id: 'old', offset: 0 }, /offset/],
    ['subagent_query', { action: 'get', id: 'old', cursor: 'cursor' }, /cursor/],
    ['subagent_query', { action: 'result', id: 'old', runId: 'run', maxBytes: 4096 }, /maxBytes/],
    ['subagent_query', { action: 'other' }, /action/],
    ['subagent', { action: 'workspace_create', workspace: 'old' }, /workspace/],
    ['subagent', { action: 'workspace_create', id: 'old' }, /id/],
    ['subagent', { action: 'workspace_create', options: {} }, /options/],
    ['subagent', { action: 'workspace_integrate' }, /workspace/],
    ['subagent', { action: 'workspace_integrate', workspace: 'old', cwd: 'other' }, /cwd/],
    ['subagent', { action: 'workspace_integrate', workspace: 'old', includeUncommitted: { reason: 'not applicable' } }, /includeUncommitted/],
    ['subagent', { action: 'create' }, /action/],
    ['subagent', { action: 'integrate', workspace: 'old' }, /action/],
    ['subagent_reply', { id: 'old', questionId: 'q', reason: 'reason', confirmed: true, actor: 'human' }, /actor/],
  ]) await assert.rejects(invoke(tool, args), pattern, JSON.stringify({tool, args}));
});

test('the result limit accepts one full report and refuses more', async () => {
  const { invoke, tools } = harness();
  const query = tools.get('subagent_query');
  for (const limit of [12001, 0]) await assert.rejects(invoke('subagent_query', { action: 'result', id: 'missing', runId: 'missing-run', limit }), /12000/);
  // The host validates the schema before execute, so the maximum must match the runtime bound.
  assert.throws(() => validateToolArguments(query, { id: 'call', name: 'subagent_query', arguments: { action: 'result', id: 'x', runId: 'y', limit: 12001 } }));
  assert.equal(validateToolArguments(query, { id: 'call', name: 'subagent_query', arguments: { action: 'result', id: 'x', runId: 'y', limit: 12000 } }).limit, 12000);
  const error = await invoke('subagent_query', { action: 'result', id: 'missing', runId: 'missing-run', limit: 12000 }).then(() => undefined, reason => reason);
  assert.ok(error, 'a missing instance must still fail');
  assert.doesNotMatch(error.message, /12000/, 'an accepted limit must not be the failure');
});

test('the reply tool exposes one structured answer map without changing the parent actor', async t => {
  const { tools, invoke } = harness(), calls = [];
  const args = { id: 'agent', questionId: 'form', answers: { checks: ['Unit'], context: ['literal, context'] }, reason: 'Authorized task context' };
  const parsed = validateToolArguments(tools.get('subagent_reply'), { id: 'call', name: 'subagent_reply', arguments: args });
  assert.deepEqual(parsed, args);
  t.mock.method(AgentManager.prototype, 'reply', async (...args) => { calls.push(args); return { id: 'agent', phase: 'running' }; });
  await invoke('subagent_reply', args);
  assert.deepEqual(calls, [['agent', 'form', { confirmed: undefined, value: undefined, answers: args.answers, cancelled: undefined },
    { actor: 'parent', reason: args.reason }]]);
});

test('the stop and workspace actions retain the existing runtime operation and target', async t => {
  const { tools, invoke } = harness(), calls = [];
  t.mock.method(AgentManager.prototype, 'get', () => ({ id: 'original', phase: 'idle', accepted: false, protocolVersion: 3, runtimeId: 'runtime', questions: [] }));
  t.mock.method(AgentManager.prototype, 'close', async id => { calls.push(['stop', id]); return { id, phase: 'stopped' }; });
  t.mock.method(WorkspaceStore.prototype, 'create', async (cwd, args) => { calls.push(['create', cwd, args]); return { id: 'workspace' }; });
  t.mock.method(WorkspaceStore.prototype, 'integrate', async id => { calls.push(['integrate', id]); return { workspace: id, status: 'applied' }; });
  await invoke('subagent', { action: 'stop', id: 'original' });
  for (const args of [{ action: 'workspace_create', includeUncommitted: { reason: 'explicit authorization' } },
    { action: 'workspace_create', cwd: 'other-repository' },
    { action: 'workspace_integrate', workspace: 'workspace' }]) {
    const parsed = validateToolArguments(tools.get('subagent'), { id: 'workspace', name: 'subagent', arguments: args });
    assert.deepEqual(parsed, args);
    await invoke('subagent', parsed);
  }
  assert.deepEqual(calls, [
    ['stop', 'original'],
    ['create', process.cwd(), { includeUncommitted: { reason: 'explicit authorization' } }],
    ['create', path.resolve(process.cwd(), 'other-repository'), { includeUncommitted: undefined }],
    ['integrate', 'workspace'],
  ]);
});

test('stop refuses an accepted turn in flight instead of discarding it', async t => {
  const { invoke } = harness(), calls = [];
  let observed = { id: 'busy', phase: 'running', accepted: true, protocolVersion: 3, runtimeId: 'runtime', questions: [] };
  t.mock.method(AgentManager.prototype, 'get', () => observed);
  t.mock.method(AgentManager.prototype, 'close', async id => { calls.push(['stop', id]); return { id, phase: 'stopped' }; });
  for (const phase of ['running', 'waiting']) {
    observed = { ...observed, phase };
    await assert.rejects(invoke('subagent', { action: 'stop', id: 'busy' }), /Interrupt first, then stop/);
  }
  // A runtime that never accepted a task (a startup dialog) and one still submitting keep the
  // release: interrupt cannot end a turn the CLI has not received.
  for (const phase of ['waiting', 'starting']) {
    observed = { ...observed, phase, accepted: false };
    await invoke('subagent', { action: 'stop', id: 'busy' });
  }
  assert.deepEqual(calls, [['stop', 'busy'], ['stop', 'busy']], 'a refused stop never reaches the runtime');
});

test('a release receipt omits the report body while an interrupt keeps it', async t => {
  const { invoke } = harness();
  const state = { id: 'original', runId: 'run', phase: 'idle', accepted: false, protocolVersion: 3, runtimeId: 'runtime',
    questions: [], text: 'FULL REPORT BODY', truncated: false, history: [{ runId: 'run', status: 'completed' }], updatedAt: 2 };
  t.mock.method(AgentManager.prototype, 'get', () => state);
  let outcome = { ...state, phase: 'closed',
    receipt: { operation: 'stop', status: 'released', runId: 'run', runtimeId: 'runtime' } };
  t.mock.method(AgentManager.prototype, 'close', async () => outcome);
  t.mock.method(AgentManager.prototype, 'interrupt', async () => ({ ...state,
    receipt: { operation: 'interrupt', status: 'settled', runId: 'run', runtimeId: 'runtime' } }));
  const parse = text => JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  for (const status of ['released', 'unconfirmed']) {
    outcome = { ...outcome, phase: status === 'released' ? 'closed' : 'unreachable',
      error: status === 'unconfirmed' ? 'Release acknowledgement missing' : undefined,
      receipt: { ...outcome.receipt, status } };
    const response = (await invoke('subagent', { action: 'stop', id: 'original' })).content[0].text;
    const shown = parse(response);
    const { text, truncated, accepted, ...metadata } = outcome;
    assert.deepEqual(shown, JSON.parse(JSON.stringify(metadata)), 'only report text and its flag are omitted');
    if (status === 'unconfirmed') assert.match(response, /confirmation is unconfirmed/);
  }
  const interrupted = parse((await invoke('subagent', { action: 'interrupt', id: 'original' })).content[0].text);
  assert.equal(interrupted.receipt.status, 'settled');
  assert.equal(interrupted.text, 'FULL REPORT BODY');
  assert.equal(interrupted.truncated, false);
});

test('activity tool forwards the exact query and cancellation signal without adding an envelope', async t => {
  const {tools,ctx}=harness(),controller=new AbortController(),expected={id:'a',entries:[],hasMore:false};
  const args={action:'activity',id:'a',cursor:'opaque',limit:3,maxBytes:4096};
  assert.deepEqual(validateToolArguments(tools.get('subagent_query'),{id:'read',name:'subagent_query',arguments:args}),args);
  t.mock.method(AgentManager.prototype,'activity',async(id,options)=>{
    assert.equal(id,'a');assert.deepEqual(options,{cursor:'opaque',limit:3,maxBytes:4096,signal:controller.signal});return expected;
  });
  const result=await tools.get('subagent_query').execute('read',args,controller.signal,undefined,ctx);
  assert.deepEqual(JSON.parse(result.content[0].text),expected);
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
