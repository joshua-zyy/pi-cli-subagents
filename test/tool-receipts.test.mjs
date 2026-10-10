import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import extension from '../dist/index.js';
import { AgentManager } from '../dist/manager.js';
import { readJson, writeJson, waitUntil } from '../dist/storage.js';
import { tempDir } from './helpers/tmp.mjs';

const fixture = fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url));
const launch = { command: process.execPath, args: [fixture] };

function setup(t) {
  const cwd = tempDir('tool-receipts');
  const home = path.join(cwd, 'agent-home'); fs.mkdirSync(home);
  const oldHome = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home;
  assert.equal(path.resolve(getAgentDir()), home, 'never load user roles or launch a configured real CLI');
  const parent = path.join(cwd, 'parent.jsonl'); fs.writeFileSync(parent, '{}\n');
  const manager = new AgentManager(parent, launch);
  const tools = new Map(), oldArgv = process.argv[1];
  process.argv[1] = fixture;
  try {
    extension({ on() {}, registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {} });
  } finally { process.argv[1] = oldArgv; }
  const ctx = { cwd, isProjectTrusted: () => false, sessionManager: { getSessionFile: () => parent } };
  t.after(async () => {
    try {
      for (const state of manager.list()) {
        if (fs.existsSync(path.join(manager.root, state.id, 'owner.lock'))) await manager.close(state.id);
      }
    } finally {
      if (oldHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldHome;
    }
  });
  return {
    cwd, manager,
    invoke: (name, args) => tools.get(name).execute('test-call', args, undefined, undefined, ctx),
    released: async (id, status = 'completed') => {
      const result = await waitUntil('run result before release', () => {
        const state = manager.get(id);
        return ['idle', 'closed'].includes(state.phase) ? state : undefined;
      }, 10000);
      assert.equal(result.lastStatus, status);
      const closed = await manager.close(id);
      assert.equal(closed.phase, 'closed'); assert.equal(closed.lastStatus, status);
      assert.equal(fs.existsSync(path.join(manager.root, id, 'owner.lock')), false);
      return closed;
    },
  };
}
const stateFrom = text => JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));

test('a refused initial task surfaces a tool error with the actual run, not a successful dispatch', { timeout: 15000 }, async t => {
  const { manager, invoke, released } = setup(t);
  let error;
  try { await invoke('subagent', { action: 'start', role: 'worker', task: 'REJECT' }); } catch (caught) { error = caught; }
  const state = await released(manager.list()[0].id, 'failed');
  assert.equal(state.phase, 'closed'); assert.equal(state.lastStatus, 'failed'); assert.equal(state.accepted, false);
  assert.equal(manager.list().length, 1);
  assert(error instanceof Error, 'the tool must fail, not return an unconditional dispatched receipt');
  assert.match(error.message, /rejected by fixture/);
  assert.doesNotMatch(error.message, /subagent dispatched|Message accepted/);
  const shown = stateFrom(error.message);
  assert.equal(shown.id, state.id); assert.equal(shown.runId, state.runId);
  assert.equal(shown.phase, 'closed'); assert.equal(shown.lastStatus, 'failed');
});

test('a mismatched native resume identity fails the tool before submitting the follow-up', { timeout: 15000 }, async t => {
  const { cwd, manager, invoke, released } = setup(t);
  const initial = await manager.spawn('worker', { description: 'fixture', instructions: 'fixture' }, cwd, 'REMEMBER original');
  const original = await released(initial.id);
  const native = readJson(original.sessionFile);
  writeJson(original.sessionFile, { ...native, id: randomUUID() });
  let error;
  try { await invoke('subagent', { action: 'send', id: initial.id, message: 'MUST NOT RUN' }); } catch (caught) { error = caught; }
  const state = await released(initial.id, 'failed');
  assert.equal(state.phase, 'closed'); assert.equal(state.lastStatus, 'failed'); assert.equal(state.accepted, false);
  assert.equal(state.sessionId, original.sessionId); assert.equal(state.runCount, 2);
  assert.equal(manager.list().length, 1);
  const prompts = readJson(original.sessionFile).messages.filter(message => message.role === 'user');
  assert.deepEqual(prompts.map(message => message.content), ['REMEMBER original']);
  assert.equal(manager.getResult(initial.id, initial.runId).text, 'OK');
  assert(error instanceof Error, 'identity refusal must not return Message accepted');
  assert.match(error.message, /different session/);
  assert.doesNotMatch(error.message, /Message accepted/);
  const shown = stateFrom(error.message);
  assert.equal(shown.id, initial.id); assert.equal(shown.runId, state.runId);
  assert.equal(shown.phase, 'closed'); assert.equal(shown.lastStatus, 'failed');
});

test('tool receipts report observed state without equating initial acceptance with this operation', async t => {
  const { cwd, invoke } = setup(t);
  const base = { id: randomUUID(), runId: randomUUID(), role: 'worker', cli: 'pi', cwd, workerPid: 0, updatedAt: 1, questions: [], logFile: 'fixture' };
  for (const [phase, accepted, error, lastStatus] of [
    // Legacy observations remain unversioned and retain their original phase.
    ['running', true], ['waiting', false], ['completed', true], ['stopped', false],
    ['failed', false, 'Pi RPC prompt timed out; acceptance is uncertain.'],
    ['failed', true, 'Task ran but failed.'],
    ['idle', true, undefined, 'completed'], ['closed', true, undefined, 'completed'],
    ['idle', true, undefined, 'stopped'], ['closed', false, undefined, 'stopped'],
    ['idle', true, 'Task ran but failed.', 'failed'],
    ['closed', false, 'Native resume rejected.', 'failed'],
    ['running', true, undefined, 'failed'], // Previous failure is not the new input's outcome.
  ]) {
    const state = { ...base, phase, accepted, ...(error ? { error } : {}),
      ...(lastStatus ? { protocolVersion: 2, runtimeId: randomUUID(), lastStatus } : {}) };
    for (const [method, tool, args] of [
      ['spawn', 'subagent', { action: 'start', role: 'worker', task: 'fixture' }],
      ['send', 'subagent', { action: 'send', id: base.id, message: 'fixture' }],
    ]) {
      const mock = t.mock.method(AgentManager.prototype, method, async () => state);
      try {
        if (phase === 'failed' || (['idle', 'closed'].includes(phase) && lastStatus === 'failed')) {
          await assert.rejects(invoke(tool, args), failure => {
            const shown = stateFrom(failure.message);
            assert.equal(shown.error, error); assert.equal(shown.runId, base.runId);
            assert.equal(shown.phase, phase); assert.equal(shown.lastStatus, lastStatus);
            assert.equal(shown.protocolVersion, state.protocolVersion); assert.equal(shown.runtimeId, state.runtimeId);
            assert.doesNotMatch(failure.message, /Message accepted|subagent dispatched|nothing (ran|executed)|not executed/i);
            return true;
          });
        } else {
          const result = await invoke(tool, args), text = result.content[0].text;
          const shown = stateFrom(text);
          assert.equal(shown.phase, phase); assert.equal(shown.lastStatus, lastStatus);
          assert.equal(shown.protocolVersion, state.protocolVersion); assert.equal(shown.runtimeId, state.runtimeId);
          assert.doesNotMatch(text, /Message accepted|subagent dispatched|wait for the final report/i);
        }
      } finally { mock.mock.restore(); }
    }
  }
});

test('public input and release receipts preserve actual operation evidence rather than infer it from phase', async t => {
  const { cwd, invoke } = setup(t);
  const base = { id:randomUUID(), runId:randomUUID(), runtimeId:randomUUID(), protocolVersion:2,
    role:'worker', cli:'pi', cwd, workerPid:0, updatedAt:1, questions:[], logFile:'fixture', phase:'running', accepted:true };
  for (const [method, operation, status] of [['spawn','start','accepted'],['spawn','start','unconfirmed'],
    ['send','send','accepted'],['send','send','queued'],['send','send','unconfirmed'],['close','stop','released']]) {
    const receipt = { operation, status, runId:base.runId, runtimeId:base.runtimeId };
    const mock = t.mock.method(AgentManager.prototype, method, async () => ({ ...base, phase:method === 'close'?'closed':'running', receipt }));
    try {
      const args = operation === 'start' ? {action:operation,role:'worker',task:'fixture'} : {action:operation,id:base.id,...(operation === 'send'?{message:'fixture'}:{})};
      const text = (await invoke('subagent',args)).content[0].text;
      assert.deepEqual(stateFrom(text).receipt,receipt);
      assert.doesNotMatch(text,/model has (read|executed)|task succeeded/i);
      if(status === 'unconfirmed') assert.match(text,/unconfirmed|not confirmed/i);
      if(status === 'queued') assert.match(text,/queued/i);
    } finally { mock.mock.restore(); }
  }
});

test('public interrupt ends the captured turn without release, and query has no synthetic delivery receipt', {timeout:15000}, async t => {
  const { manager, invoke } = setup(t);
  const initial = stateFrom((await invoke('subagent',{action:'start',role:'worker',task:'HOLD'})).content[0].text);
  await assert.rejects(invoke('subagent',{action:'interrupt',id:initial.id,message:'forbidden extra'}),/not allowed/);
  const interrupted = stateFrom((await invoke('subagent',{action:'interrupt',id:initial.id})).content[0].text);
  assert.equal(interrupted.receipt.status,'settled'); assert.equal(interrupted.receipt.operation,'interrupt');
  assert.equal(interrupted.phase,'idle'); assert.equal(interrupted.runtimeId,initial.runtimeId); assert.equal(interrupted.runId,initial.runId);
  assert(fs.existsSync(path.join(manager.root,initial.id,'owner.lock')));
  const noop = stateFrom((await invoke('subagent',{action:'interrupt',id:initial.id})).content[0].text);
  assert.equal(noop.receipt.status,'not_running');
  const inspected = stateFrom((await invoke('subagent_query',{action:'get',id:initial.id})).content[0].text);
  assert.equal(inspected.receipt,undefined); assert.equal(readJson(path.join(manager.root,initial.id,'state.json')).receipt,undefined);
  const closed = stateFrom((await invoke('subagent',{action:'stop',id:initial.id})).content[0].text);
  assert.equal(closed.receipt.status,'released'); assert.equal(closed.phase,'closed');
  assert.equal(manager.getResult(initial.id,initial.runId).status,'stopped');
});
