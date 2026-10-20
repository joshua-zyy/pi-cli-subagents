import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentManager } from '../dist/manager.js';
import extension from '../dist/index.js';
import { deliverReports } from '../dist/notifier.js';
import { TranscriptReader } from '../dist/transcript.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJson, waitUntil, processAlive, writeJson } from '../dist/storage.js';
import { tempDir } from './helpers/tmp.mjs';
const fixture = fileURLToPath(new URL('./fixtures/codex.mjs', import.meta.url));
const pi = fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url));
const role = { cli: 'codex', description: 'fixture', instructions: 'Do only this task', model: 'gpt-6-luna', effort: 'medium' };

test('worker preserves Codex uncertain input state until explicit protected release', { timeout: 15000 }, async t => {
  const { cwd, manager, options } = setup(t); options.launch.args.push('--wrong-steer-target');
  const child = await manager.spawn('worker', role, cwd, 'HOLD');
  await assert.rejects(manager.send(child.id, 'uncertain'), /uncertain|different steer target/i);
  const state = manager.get(child.id); assert.equal(state.phase, 'unreachable');
  await assert.rejects(manager.send(child.id, 'must not send'), /uncertain|different steer target/i);
  const closed = await manager.close(child.id, false, { runId: state.runId, runtimeId: state.runtimeId }, true);
  assert.equal(closed.receipt.status, 'released');
});
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
      await waitUntil('closed worker exit', () => !processAlive(manager.get(state.id).workerPid), 5000);
    }
  });
  const done = async (id, status = 'completed') => {
    const state = await waitUntil('run result', () => {
      const s = manager.get(id);
      return ['idle', 'closed'].includes(s.phase) ? s : undefined;
    }, 12_000);
    assert.equal(state.lastStatus, status);
    return state;
  };
  const release = async (id, status = 'completed') => {
    await done(id, status);
    const closed = await manager.close(id);
    assert.equal(closed.phase, 'closed'); assert.equal(closed.lastStatus, status);
    assert.equal(fs.existsSync(path.join(manager.root, id, 'owner.lock')), false);
    return closed;
  };
  return { cwd, home, manager, done, release, parent, launch, options };
}

test('manager preserves Codex and Pi native identity across a fresh controller', { timeout: 30_000 }, async t => {
  const { cwd, home, manager, done, release, parent, launch, options } = setup(t);
  const launchRole = { ...role, defaultModeQuestions: true };
  const started = await manager.spawn('codex-worker', launchRole, cwd, 'REMEMBER alpha');
  const first = await release(started.id);
  assert.equal(first.cli, 'codex'); assert.equal(first.session.cli, 'codex'); assert.equal(first.session.codexHome, home);
  assert.ok(first.session.threadId); assert.notEqual(first.session.threadId, first.sessionId); assert.equal(first.sessionFile, undefined);
  launchRole.defaultModeQuestions = false; // New role edits must not rewrite the existing instance's snapshot.
  const reopened = new AgentManager(parent, launch, { ...options, home: path.join(cwd, 'different-home') });
  const next = await reopened.send(started.id, 'RECALL');
  const result = await done(next.id);
  assert.equal(result.text, 'alpha'); assert.deepEqual(result.session, first.session); assert.equal(result.runCount, 2);
  assert.equal(manager.reports().filter(r => r.agentId === result.id && r.status === 'completed').length, 2);
  const starts = fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(r => r.method === 'initialize');
  assert.ok(starts.length >= 2);
  assert.ok(starts.every(r => r.launchArgs.includes('features.default_mode_request_user_input=true')), 'continuations keep the saved question override');
  assert.equal(readJson(path.join(manager.root, started.id, 'spec.json')).role.defaultModeQuestions, true);
  const piStarted = await manager.spawn('worker', { description: 'old Pi', instructions: 'test' }, cwd, 'REMEMBER beta');
  const piFirst = await release(piStarted.id);
  const spec = path.join(manager.root, piStarted.id, 'spec.json');
  const state = path.join(manager.root, piStarted.id, 'state.json');
  const saved = readJson(state), s = { ...saved }; delete s.session; writeJson(state, s);
  await assert.rejects(reopened.send(piStarted.id, 'must not repair old session fields'), /No resumable original session/);
  assert.equal(reopened.get(piStarted.id).runCount, 1);
  writeJson(state, saved);
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

test('Codex async messages reach the public reply tool before completion with one audit and captured-turn steer', { timeout: 20_000 }, async t => {
  const { cwd, home, manager, done, parent } = setup(t);
  const tools = new Map(), messages = [], notices = [];
  const api = { registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, on() {},
    sendMessage: (message, options) => messages.push({ message, options }) };
  extension(api);
  const ctx = { cwd, hasUI: true, sessionManager: { getSessionFile: () => parent, getEntries: () => [] }, ui: { notify: (...args) => notices.push(args), setStatus() {} } };
  const invoke = (name, args) => tools.get(name).execute('fixture-parent', args, new AbortController().signal, () => {}, ctx);
  const started = await manager.spawn('oracle', role, cwd, 'ASYNC_QUESTION_DUPLICATE');
  const current = manager.get(started.id);
  assert.equal(current.questions.length, 1, 'the parent must see the async question while the original run is active');
  assert.equal(current.phase, 'running');
  const q = current.questions[0]; assert.equal(q.fields.every(f => f.required === true), true);
  deliverReports(manager, api, ctx, new Set(), Date.now(), manager.list());
  assert.equal(notices.length, 0); assert.equal(messages.length, 1);
  assert.equal(messages[0].options.deliverAs, 'steer'); assert.match(messages[0].message.content, /required.*non-blank/i);
  const auditFile = path.join(manager.root, started.id, 'runs', started.runId, 'permissions.jsonl');
  const base = { id: started.id, questionId: q.id, reason: 'Only the assigned non-sensitive task context' };
  for (const invalid of [{ confirmed: true }, { answers: { '0': [], '1': ['context'] } }, { answers: { '0': [' '], '1': ['context'] } },
    { answers: { '0': ['Unit', 'Integration'], '1': ['context'] } }])
    await assert.rejects(invoke('subagent_reply', { ...base, ...invalid }), /response|answers|required|one answer/i);
  assert.equal(fs.existsSync(auditFile), false);
  await invoke('subagent_reply', { ...base, answers: { '0': ['custom choice'], '1': ['literal context'] } });
  const final = await done(started.id);
  assert.equal(final.text, 'Answers to your questions:\n\nWhich check?\ncustom choice\n\nWhat context is missing?\nliteral context');
  assert.equal(final.runId, started.runId); assert.equal(final.runtimeId, started.runtimeId); assert.deepEqual(final.session, started.session);
  const audit = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(audit.length, 1); assert.equal(audit[0].decision, 'answered'); assert.equal(audit[0].actor, 'parent');
  const native = fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(native.filter(r => r.method === 'turn/steer').length, 1); assert.equal(native.filter(r => r.method === 'turn/start').length, 1);
  assert.equal(native.filter(r => !r.method).length, 0); assert.deepEqual(final.questions, []);
});

test('Codex forms reach the public parent reply tool with scoped answers, notifications, and non-blocking steer', { timeout: 30_000 }, async t => {
  const { cwd, home, manager, done, parent } = setup(t);
  const tools = new Map(), notices = [], messages = [], statuses = [];
  const api = { registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, on() {},
    sendMessage: (message, options) => messages.push({ message, options }) };
  extension(api);
  const ctx = { cwd, hasUI: true, sessionManager: { getSessionFile: () => parent, getEntries: () => [] },
    ui: { notify: (...args) => notices.push(args), setStatus: (_key, status) => statuses.push(status) } };
  const invoke = (name, args) => tools.get(name).execute('fixture-parent', args, new AbortController().signal, () => {}, ctx);
  const answers = { checks: ['Unit'], context: ['literal, task context\nsecond line'] };
  for (const task of ['DEFAULT_QUESTION', 'QUESTION_NONBLOCKING', 'QUESTION_CANCEL']) {
    const started = await manager.spawn('codex-worker', { ...role, defaultModeQuestions: true }, cwd, task);
    const pending = await waitUntil('Codex form visibility', () => {
      const state = manager.get(started.id); return state.questions.length ? state : undefined;
    });
    const q = pending.questions[0], nonBlocking = task.includes('NONBLOCKING');
    assert.equal(pending.phase, nonBlocking ? 'running' : 'waiting'); assert.equal(q.isBlocking, !nonBlocking);
    assert.equal(q.method, 'form'); assert.equal(q.kind, 'question'); assert.deepEqual(q.parentPolicy, { answers: true });
    assert.deepEqual(q.fields.map(f => f.id), ['checks', 'context']);
    const query = await invoke('subagent_query', { action: 'get', id: started.id });
    assert.deepEqual(JSON.parse(query.content[0].text).agents[0].questions[0].fields, q.fields);
    const report = manager.reports().find(r => r.agentId === started.id && r.status === 'waiting');
    assert.equal(report.questionId, q.id); assert.deepEqual(report.request.fields, q.fields); assert.equal(report.request.isBlocking, !nonBlocking);
    deliverReports(manager, api, ctx, new Set(), Date.now(), manager.list());
    assert.equal(notices.length, 0, 'a supported task form does not demand human approval');
    const notice = messages.find(entry => entry.message.details?.ids?.includes(report.notificationId));
    assert(notice); assert.equal(notice.options.deliverAs, 'steer'); assert.match(notice.message.content, /answers object.*field ID/s);
    if (nonBlocking) {
      assert.match(notice.message.content, /non-blocking/); assert.match(statuses.at(-1), /pending questions while running/);
      await invoke('subagent', { action: 'send', id: started.id, message: 'HOLD', mode: 'steer' });
      assert.equal(manager.get(started.id).phase, 'running'); assert.equal(manager.get(started.id).runId, started.runId);
    } else await assert.rejects(manager.send(started.id, 'HOLD'), /unresolved interaction/);
    const base = { id: started.id, questionId: q.id, reason: 'Only the user-authorized fixture context' };
    for (const invalid of [{ confirmed: true }, { value: 'approve' }, { answers: { checks: ['Unit'] } },
      { answers: { ...answers, foreign: [] } }, { answers: { ...answers, checks: ['acceptForSession'] } },
      { answers, confirmed: true }]) await assert.rejects(invoke('subagent_reply', { ...base, ...invalid }), /answers|response|field|choice|offered/i);
    const auditFile = path.join(manager.root, started.id, 'runs', started.runId, 'permissions.jsonl');
    assert.equal(fs.existsSync(auditFile), false, 'invalid answers are rejected before the attempted-answer audit');
    const cancelled = task.includes('CANCEL');
    await invoke('subagent_reply', { ...base, ...(cancelled ? { cancelled: true } : { answers }) });
    const final = await done(started.id);
    const expected = cancelled ? {} : Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, { answers: values }]));
    assert.deepEqual(JSON.parse(final.text), expected); assert.equal(final.runId, started.runId); assert.deepEqual(final.session, started.session);
    assert.deepEqual(final.questions, []); assert(!manager.reports().some(r => r.agentId === started.id && r.status === 'waiting'));
    const audit = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(audit.length, 1); assert.equal(audit[0].kind, 'question'); assert.equal(audit[0].actor, 'parent');
    assert.equal(audit[0].decision, cancelled ? 'cancelled' : 'answered'); assert.equal(audit[0].reason, base.reason);
    assert(!JSON.stringify(audit).includes('literal, task context'), 'answer contents are not copied into the permission audit');
    await assert.rejects(invoke('subagent_reply', { ...base, answers }), /exited|ended|pending/i);
    const native = readJson(path.join(home, `${final.session.threadId}.json`));
    assert.equal(native.turns.length, 1); assert.equal(native.turns[0].items.filter(item => item.type === 'userMessage').length, 1);
  }
  const records = fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const responses = records.filter(r => !r.method);
  assert.equal(responses.length, 3); assert(responses.every(r => Object.keys(r.result).join() === 'answers'));
  assert.equal(records.filter(r => r.method === 'turn/start').length, 3); assert.equal(records.filter(r => r.method === 'turn/steer').length, 1);
});

test('Codex MCP approvals reach public tools, parent notification, audit and the original run result', { timeout: 25_000 }, async t => {
  const { cwd, home, manager, done, parent } = setup(t);
  const tools = new Map(), messages = [], notices = [];
  const api = { registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, on() {},
    sendMessage: (message, options) => messages.push({ message, options }) };
  extension(api);
  const ctx = { cwd, sessionManager: { getSessionFile: () => parent, getEntries: () => [] },
    ui: { notify: (...args) => notices.push(args), setStatus() {} } };
  const invoke = (name, args) => tools.get(name).execute('fixture-parent', args, new AbortController().signal, () => {}, ctx);
  for (const [task, answer] of [['MCP_APPROVAL', { value: 'Allow' }], ['MCP_APPROVAL', { value: 'Cancel' }],
    ['MCP_ELICIT', { confirmed: true }], ['MCP_ELICIT', { confirmed: false }], ['MCP_ELICIT', { cancelled: true }]]) {
    const prefix = task === 'MCP_APPROVAL';
    const action = prefix ? answer.value : answer.cancelled ? 'cancel' : answer.confirmed ? 'accept' : 'decline';
    const started = await manager.spawn('codex-worker', role, cwd, task);
    const pending = manager.get(started.id), q = pending.questions[0];
    assert.equal(pending.phase, 'waiting'); assert(q); assert.equal(q.fields, undefined); assert.notEqual(q.kind, 'question');
    assert.equal(q.method, prefix ? 'select' : 'confirm');
    const query = JSON.parse((await invoke('subagent_query', { action: 'get', id: started.id })).content[0].text);
    assert.deepEqual(query.agents[0].questions, pending.questions);
    const report = manager.reports().find(r => r.agentId === started.id && r.status === 'waiting'); assert(report);
    deliverReports(manager, api, ctx, new Set(), Date.now(), manager.list());
    const message = messages.find(m => m.message.details.ids.includes(report.notificationId));
    assert.equal(message.options.deliverAs, 'steer'); assert.match(message.message.content, /Handle this request now.*user's task authorization/);
    assert.equal(notices.length, 0, 'single-call permission defaults to parent review, even when native persistent options exist');
    await assert.rejects(invoke('subagent', { action: 'send', id: started.id, message: 'Allow' }), /unresolved interaction/);
    const base = { id: started.id, questionId: q.id, reason: 'Only the user-authorized fixture write' };
    for (const bad of [{ value: 'Allow for this session' }, { value: "Allow and don't ask me again" },
      prefix ? { confirmed: true } : { value: 'Allow' }, { answers: {} }, { ...answer, reason: '' }])
      await assert.rejects(invoke('subagent_reply', { ...base, ...bad }), /option|type|reason|response/i);
    const auditFile = path.join(manager.root, started.id, 'runs', started.runId, 'permissions.jsonl');
    assert.equal(fs.existsSync(auditFile), false, 'invalid requests are rejected before the intent audit');
    await invoke('subagent_reply', { ...base, ...answer });
    const final = await done(started.id, answer.value === 'Cancel' || answer.cancelled ? 'stopped' : 'completed');
    assert.equal(final.runId, started.runId); assert.deepEqual(final.session, started.session);
    assert.equal(final.text, `${prefix ? 'MCP' : 'ELICITATION'}:${action}`); assert.equal(final.questions.length, 0);
    const audit = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(audit.length, 1); assert.equal(audit[0].actor, 'parent'); assert.equal(audit[0].selectedOption, answer.value);
    assert.equal(audit[0].decision, answer.cancelled ? 'cancelled' : prefix ? 'answered' : answer.confirmed ? 'approved' : 'denied');
    assert.equal(audit[0].reason, base.reason); assert.equal(audit[0].kind, undefined, 'not audited as a task question');
    assert.ok(!JSON.stringify(audit).includes('-only.txt'), 'action arguments are not copied to the decision audit');
    const result = JSON.parse((await invoke('subagent_query', { action: 'result', id: started.id, runId: started.runId })).content[0].text);
    assert.equal(result.text, final.text);
    await assert.rejects(invoke('subagent_reply', { ...base, ...answer }), /exited|ended|pending/);
    assert.ok(!manager.reports().some(r => r.agentId === started.id && r.status === 'waiting'));
  }
  const native = fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(native.filter(r => r.method === 'turn/start').length, 5, 'reply is not another prompt');
  assert.equal(native.filter(r => !r.method && r.result?.answers).length, 2);
  const elicitations = native.filter(r => !r.method && r.result?.action);
  assert.equal(elicitations.length, 3);
  assert.ok(elicitations.every(r => r.result.content === null && r.result._meta === null));
  for (const kind of ['mcp', 'elicitation']) {
    assert.equal(fs.readFileSync(path.join(home, `${kind}-effect.txt`), 'utf8'), '1');
    assert.equal(fs.existsSync(path.join(home, `${kind}-grants.jsonl`)), false);
  }
});

test('Codex accept/cancel-only choices route through the worker and record the exact selection', { timeout: 20_000 }, async t => {
  const { cwd, manager, done, home } = setup(t);
  for (const [value, status] of [['Approve once', 'completed'], ['Cancel turn', 'stopped']]) {
    const started = await manager.spawn('codex-worker', role, cwd, 'APPROVAL_ACCEPT_CANCEL');
    const waiting = await waitUntil('native approval or failure', () => {
      const state = manager.get(started.id); return ['waiting', 'idle', 'closed'].includes(state.phase) ? state : undefined;
    });
    assert.equal(waiting.phase, 'waiting');
    const q = waiting.questions[0]; assert.equal(q.method, 'select'); assert.deepEqual(q.options, ['Approve once', 'Cancel turn']);
    await assert.rejects(manager.reply(started.id, q.id, { confirmed: false }), /Response type/);
    await assert.rejects(manager.reply(started.id, q.id, { value: 'acceptForSession' }), /available options/);
    await manager.reply(started.id, q.id, { value }, { actor: 'parent', reason: 'Only this explicit fixture choice is authorized.' });
    const final = await done(started.id, status);
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

test('Codex spawns a role without a model through the manager and inherits the native default', { timeout: 20_000 }, async t => {
  const { cwd, home, manager, done, release } = setup(t);
  const started = await manager.spawn('codex-worker', { ...role, model: undefined }, cwd, 'REMEMBER inherit');
  const finished = await done(started.id);
  assert.equal(finished.lastStatus, 'completed'); assert.equal(finished.text, 'OK'); assert.equal(finished.runCount, 1);
  assert.equal(readJson(path.join(manager.root, started.id, 'spec.json')).role.model, undefined, 'the spec keeps the omission');
  const threadStart = fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find(r => r.method === 'thread/start');
  assert.equal('model' in threadStart.params, false, 'no model is sent when the role omits one');
  assert.equal('allowProviderModelFallback' in threadStart.params, false, 'fallback policy stays native');
  await release(started.id);
});

test('Codex rejects retired workspace arguments and invalid defaultModeQuestions before creating instances', async t => {
  const { cwd, manager } = setup(t);
  await assert.rejects(manager.spawn('codex-worker', role, cwd, 'DO', 'any-workspace'), /workspace.*retired/i);
  for (const invalid of [{ ...role, defaultModeQuestions: 'true' }, { ...role, defaultModeQuestions: null },
    { ...role, cli: 'pi', defaultModeQuestions: false }, { ...role, cli: 'claude', defaultModeQuestions: true }])
    await assert.rejects(manager.spawn('worker', invalid, cwd, 'DO'), /defaultModeQuestions/);
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
  const { cwd, manager, done, release, home } = setup(t);
  const started = await manager.spawn('codex-worker', role, cwd, 'REMEMBER alpha');
  const first = await release(started.id);
  fs.renameSync(path.join(home, `${first.session.threadId}.json`), path.join(home, 'removed.json'));
  const failed = await manager.send(first.id, 'RECALL');
  assert.equal(failed.phase, 'closed'); assert.equal(failed.lastStatus, 'failed');
  assert.match(failed.error, /Original thread missing/);
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
