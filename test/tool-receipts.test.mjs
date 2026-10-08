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
    released: id => waitUntil('terminal state and owner release', () => {
      const state = manager.get(id);
      return ['completed', 'failed', 'stopped'].includes(state.phase) && !fs.existsSync(path.join(manager.root, id, 'owner.lock')) ? state : undefined;
    }, 10000),
  };
}
const stateFrom = text => JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));

test('a refused initial task surfaces a tool error with the actual run, not a successful dispatch', { timeout: 15000 }, async t => {
  const { manager, invoke, released } = setup(t);
  let error;
  try { await invoke('subagent', { action: 'start', role: 'worker', task: 'REJECT' }); } catch (caught) { error = caught; }
  const state = await released(manager.list()[0].id);
  assert.equal(state.phase, 'failed'); assert.equal(state.accepted, false);
  assert.equal(manager.list().length, 1);
  assert(error instanceof Error, 'the tool must fail, not return an unconditional dispatched receipt');
  assert.match(error.message, /rejected by fixture/);
  assert.doesNotMatch(error.message, /subagent dispatched|Message accepted/);
  const shown = stateFrom(error.message);
  assert.equal(shown.id, state.id); assert.equal(shown.runId, state.runId); assert.equal(shown.phase, 'failed');
});

test('a mismatched native resume identity fails the tool before submitting the follow-up', { timeout: 15000 }, async t => {
  const { cwd, manager, invoke, released } = setup(t);
  const initial = await manager.spawn('worker', { description: 'fixture', instructions: 'fixture' }, cwd, 'REMEMBER original');
  const original = await released(initial.id);
  const native = readJson(original.sessionFile);
  writeJson(original.sessionFile, { ...native, id: randomUUID() });
  let error;
  try { await invoke('subagent', { action: 'send', id: initial.id, message: 'MUST NOT RUN' }); } catch (caught) { error = caught; }
  const state = await released(initial.id);
  assert.equal(state.phase, 'failed'); assert.equal(state.accepted, false);
  assert.equal(state.sessionId, original.sessionId); assert.equal(state.runCount, 2);
  assert.equal(manager.list().length, 1);
  const prompts = readJson(original.sessionFile).messages.filter(message => message.role === 'user');
  assert.deepEqual(prompts.map(message => message.content), ['REMEMBER original']);
  assert.equal(manager.getResult(initial.id, initial.runId).text, 'OK');
  assert(error instanceof Error, 'identity refusal must not return Message accepted');
  assert.match(error.message, /different session/);
  assert.doesNotMatch(error.message, /Message accepted/);
  const shown = stateFrom(error.message);
  assert.equal(shown.id, initial.id); assert.equal(shown.runId, state.runId); assert.equal(shown.phase, 'failed');
});

test('tool receipts report observed state without equating initial acceptance with this operation', async t => {
  const { cwd, invoke } = setup(t);
  const base = { id: randomUUID(), runId: randomUUID(), role: 'worker', cli: 'pi', cwd, workerPid: 0, updatedAt: 1, questions: [], logFile: 'fixture' };
  for (const [phase, accepted, error] of [
    ['running', true], ['waiting', false], ['completed', true], ['stopped', false],
    ['failed', false, 'Pi RPC prompt timed out; acceptance is uncertain.'],
    ['failed', true, 'Task ran but failed.'],
  ]) {
    const state = { ...base, phase, accepted, ...(error ? { error } : {}) };
    for (const [method, tool, args] of [
      ['spawn', 'subagent', { action: 'start', role: 'worker', task: 'fixture' }],
      ['send', 'subagent', { action: 'send', id: base.id, message: 'fixture' }],
    ]) {
      const mock = t.mock.method(AgentManager.prototype, method, async () => state);
      try {
        if (phase === 'failed') {
          await assert.rejects(invoke(tool, args), failure => {
            assert.equal(stateFrom(failure.message).error, error);
            assert.equal(stateFrom(failure.message).runId, base.runId);
            assert.doesNotMatch(failure.message, /Message accepted|subagent dispatched|nothing (ran|executed)|not executed/i);
            return true;
          });
        } else {
          const result = await invoke(tool, args), text = result.content[0].text;
          assert.equal(stateFrom(text).phase, phase);
          assert.doesNotMatch(text, /Message accepted|subagent dispatched|wait for the final report/i);
        }
      } finally { mock.mock.restore(); }
    }
  }
});
