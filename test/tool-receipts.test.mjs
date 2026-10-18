import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import extension from '../dist/index.js';
import { AgentManager } from '../dist/manager.js';
import { control } from '../dist/control.js';
import { deliverReports } from '../dist/notifier.js';
import { readJson, writeJson, waitUntil } from '../dist/storage.js';
import { tempDir } from './helpers/tmp.mjs';

const fixture = fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url));
const launch = { command: process.execPath, args: [fixture] };

test('handled Pi initial and resident inputs fail with no accepted turn and release the runtime', { timeout: 15000 }, async t => {
  const { cwd, manager, invoke } = setup(t);
  await assert.rejects(invoke('subagent', { action: 'start', role: 'worker', task: 'HANDLED' }), /handled.*no native run/i);
  const first = manager.list()[0];
  await waitUntil('handled startup release', () => manager.get(first.id).phase === 'closed');
  assert.equal(manager.get(first.id).accepted, false);
  assert.equal(manager.getResult(first.id, first.runId).status, 'failed');
  const next = await manager.spawn('worker', { description: 'fixture', instructions: 'fixture' }, cwd, 'DONE');
  await waitUntil('idle', () => manager.get(next.id).phase === 'idle');
  await assert.rejects(invoke('subagent', { action: 'send', id: next.id, message: 'HANDLED' }), /handled.*no native run/i);
  await waitUntil('handled resident release', () => manager.get(next.id).phase === 'closed');
  const last = manager.get(next.id);
  assert.equal(last.accepted, false); assert.equal(last.lastStatus, 'failed');
});

test('public stop refuses a new accepted run after its preflight', { timeout: 15000 }, async t => {
  const { cwd, manager, invoke } = setup(t);
  const first = await manager.spawn('worker', { description: 'fixture', instructions: 'fixture' }, cwd, 'DONE');
  await waitUntil('idle', () => manager.get(first.id).phase === 'idle');
  const close = AgentManager.prototype.close;
  let next;
  const mock = t.mock.method(AgentManager.prototype, 'close', async function(id, ...args) {
    next = await manager.send(id, 'HOLD next');
    return close.call(this, id, ...args);
  });
  try { await assert.rejects(invoke('subagent', { action: 'stop', id: first.id }), /captured|identity|in flight/i); }
  finally { mock.mock.restore(); }
  assert.equal(manager.get(first.id).phase, 'running');
  assert.equal(manager.get(first.id).runId, next.runId);
});

test('worker checks accepted-run protection at release execution', { timeout: 15000 }, async t => {
  const { cwd, manager } = setup(t);
  const child = await manager.spawn('worker', { description: 'fixture', instructions: 'fixture' }, cwd, 'HOLD');
  const endpoint = readJson(path.join(manager.root, child.id, 'endpoint.json'));
  await assert.rejects(control({ ...endpoint, preserveAccepted: undefined }, { type: 'close', preserveAccepted: true }), /cannot protect accepted turns/);
  await assert.rejects(control(endpoint, { type: 'close', preserveAccepted: true }), /in flight/i);
  assert.equal(manager.get(child.id).phase, 'running');
  await manager.interrupt(child.id);
  const result = await control(endpoint, { type: 'close', preserveAccepted: true });
  assert.equal(result.receipt.status, 'released');
});

test('worker control preserves split UTF-8 and limits raw request bytes', { timeout: 15000 }, async t => {
  const { cwd, manager } = setup(t);
  const child = await manager.spawn('worker', { description: 'fixture', instructions: 'fixture' }, cwd, 'HOLD');
  const endpoint = readJson(path.join(manager.root, child.id, 'endpoint.json'));
  const post = (message, split) => new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ type: 'send', message, mode: 'steer', protocolVersion: 2,
      runtimeId: endpoint.runtimeId, expectedRunId: endpoint.runId }));
    const req = request({ hostname: '127.0.0.1', port: endpoint.port, method: 'POST', path: '/',
      headers: { authorization: `Bearer ${endpoint.token}` } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({ code: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    if (split === undefined) req.end(body);
    else { req.write(body.subarray(0, split)); setTimeout(() => req.end(body.subarray(split)), 20); }
  });
  const message = 'HOLD 请审查😀';
  const wire = Buffer.from(JSON.stringify({ type: 'send', message }));
  for (const [character, offsets] of [['请', [1, 2]], ['😀', [1, 2, 3]]]) {
    for (const offset of offsets) {
      assert.equal((await post(message, wire.indexOf(Buffer.from(character)) + offset)).code, 200);
      assert.equal(readJson(child.sessionFile).messages.at(-1).content, message);
    }
  }
  const count = readJson(child.sessionFile).messages.length;
  const oversized = await post('HOLD ' + '雪'.repeat(400000));
  assert.equal(oversized.code, 400); assert.match(oversized.body.error, /too large/);
  assert.equal(readJson(child.sessionFile).messages.length, count, 'oversized input must not reach native');
});

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
  // The stop tool refuses an accepted turn in flight, so that row's runtime has none: the tool
  // reads this view before it dispatches, and a busy one would be refused rather than receipted.
  const releasable = { ...base, phase:'idle', accepted:false };
  for (const [method, operation, status] of [['spawn','start','accepted'],['spawn','start','unconfirmed'],
    ['send','send','accepted'],['send','send','queued'],['send','send','unconfirmed'],['close','stop','released']]) {
    const observed = method === 'close' ? releasable : base;
    const receipt = { operation, status, runId:base.runId, runtimeId:base.runtimeId };
    const mock = t.mock.method(AgentManager.prototype, method, async () => ({ ...observed, phase:method === 'close'?'closed':'running', receipt }));
    const view = t.mock.method(AgentManager.prototype, 'get', () => observed);
    try {
      const args = operation === 'start' ? {action:operation,role:'worker',task:'fixture'} : {action:operation,id:base.id,...(operation === 'send'?{message:'fixture'}:{})};
      const text = (await invoke('subagent',args)).content[0].text;
      assert.deepEqual(stateFrom(text).receipt,receipt);
      assert.doesNotMatch(text,/model has (read|executed)|task succeeded/i);
      if(status === 'unconfirmed') assert.match(text,/unconfirmed|not confirmed/i);
      if(status === 'queued') assert.match(text,/queued/i);
    } finally { view.mock.restore(); mock.mock.restore(); }
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

test('a released instance keeps an undelivered report deliverable exactly once', { timeout: 20000 }, async t => {
  const { manager, invoke, released } = setup(t);
  const started = stateFrom((await invoke('subagent', { action: 'start', role: 'worker', task: 'RELEASE ME' })).content[0].text);
  const closed = await released(started.id);
  assert.equal(closed.phase, 'closed'); assert.equal(closed.lastStatus, 'completed');
  const receipt = stateFrom((await invoke('subagent', { action: 'stop', id: started.id })).content[0].text);
  assert.equal(receipt.receipt.status, 'released');
  assert.equal(receipt.phase, 'closed');
  assert.equal(Object.hasOwn(receipt, 'text'), false, 'a release receipt must not repeat the report body');
  const notificationId = `${started.runId}-result`;
  const report = manager.reports().find(r => r.notificationId === notificationId);
  assert.ok(report, 'release must not drop the completed report');
  const page = JSON.parse((await invoke('subagent_query', { action: 'result', id: started.id, runId: started.runId })).content[0].text);
  assert.equal(page.agentId, started.id); assert.equal(page.runId, started.runId);
  assert.equal(page.text, 'RELEASE ME'); assert.equal(page.nextOffset, null);
  const entries = [], sent = [];
  const ctx = { sessionManager: { getEntries: () => entries }, ui: { notify() {}, setStatus() {} } };
  const pi = { sendMessage: (message, options) => sent.push({ message, options }) };
  const pending = new Set(), now = report.time + 2100;
  deliverReports(manager, pi, ctx, pending, now);
  assert.equal(sent.length, 1, 'a released instance still delivers its undelivered report');
  assert.deepEqual(sent[0].message.details.ids, [notificationId]);
  assert.match(sent[0].message.content, /RELEASE ME/);
  deliverReports(manager, pi, ctx, pending, now + 800);
  assert.equal(sent.length, 1, 'a queued notification must not be repeated while it is pending');
  entries.push({ type: 'custom_message', customType: 'cli-subagents-report', details: { ids: [notificationId] } });
  deliverReports(manager, pi, ctx, new Set(), now + 1600);
  assert.equal(sent.length, 1, 'the persisted receipt must prevent a replay after release');
});
