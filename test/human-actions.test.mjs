// Real local outbox files and SDK routing only: no CLI, model, user configuration or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { AgentSession } from '@earendil-works/pi-coding-agent';
import { humanActionType, createHumanActionBatch, saveHumanAction, saveHumanActionBatch, deliverHumanActions } from '../dist/human-actions.js';
import { deliveredIds } from '../dist/notifier.js';
import { readJson, writeJson } from '../dist/storage.js';
import { tempDir } from './helpers/tmp.mjs';

function setup() {
  const cwd = tempDir('human-actions'), parentFile = path.join(cwd, 'parent.jsonl');
  fs.writeFileSync(parentFile, '{}\n');
  const manager = { root: `${parentFile}.subagents`, parentFile }, entries = [], sent = [], pending = new Set();
  fs.mkdirSync(manager.root);
  const h = { cwd, manager, entries, sent, pending, current: parentFile };
  h.ctx = { sessionManager: { getSessionFile: () => h.current, getEntries: () => entries,
    getBranch: () => { throw Error('receipts use the whole session, not just its active branch'); } } };
  h.pi = { sendMessage: (message, options) => sent.push({ message, options }) };
  h.agent = () => {
    const agent = { id: randomUUID(), runId: randomUUID(), runtimeId: randomUUID(), role: 'worker', phase: 'idle', lastStatus: 'completed' };
    writeJson(path.join(manager.root, agent.id, 'spec.json'), { version: 1, id: agent.id, parentFile, roleName: agent.role });
    return agent;
  };
  h.add = (text = 'Human stopped the original task.', agent = h.agent()) => {
    const folder = path.join(manager.root, agent.id, 'human-actions');
    const before = fs.existsSync(folder) ? fs.readdirSync(folder) : [];
    saveHumanAction(manager, agent, text);
    const name = fs.readdirSync(folder).find(name => !before.includes(name));
    const file = path.join(folder, name);
    return { agent, file, record: readJson(file) };
  };
  h.batch = (count = 2) => {
    const targets = Array.from({ length: count }, h.agent), record = createHumanActionBatch(manager, targets);
    const file = path.join(manager.root, targets[0].id, 'human-actions', `${record.id}.json`);
    return { targets, record, file };
  };
  h.deliver = (pending = h.pending) => deliverHumanActions(manager, h.pi, h.ctx, pending);
  return h;
}

function sdkHost(h, streaming) {
  const forbidden = () => { throw Error('human actions must not start, steer, follow up or abort a model run'); };
  const events = [], calls = [];
  const host = { isStreaming: streaming, _pendingCustomMessages: [], _pendingNextTurnMessages: [],
    agent: { steer: forbidden, followUp: forbidden, abort: forbidden }, _runAgentPrompt: forbidden,
    sessionManager: { appendCustomMessageEntry(customType, content, display, details) {
      h.entries.push({ type: 'custom_message', customType, content, display, details });
    } },
    _refreshFinalizedContext() {}, _emit: event => events.push(event),
    _appendCustomMessage: AgentSession.prototype._appendCustomMessage,
  };
  h.pi.sendMessage = (message, options) => {
    h.sent.push({ message, options });
    calls.push(AgentSession.prototype.sendCustomMessage.call(host, message, options));
  };
  return { host, events, calls };
}

test('batch progress is atomic, captures plain identities, and stays undelivered until sealed', t => {
  const h = setup(), targets = Array.from({ length: 9 }, h.agent);
  for (const target of targets) { target.configuration = { secret: 'fixture-only' }; target.toJSON = () => { throw Error('never serialize an AgentView'); }; }
  const before = targets.map(({ id, runId, runtimeId, role }) => ({ id, runId, runtimeId, role }));
  const record = createHumanActionBatch(h.manager, targets), folder = path.join(h.manager.root, targets[0].id, 'human-actions');
  assert.deepEqual(fs.readdirSync(folder), [`${record.id}.json`]);
  h.deliver(); assert.equal(h.sent.length, 0); assert.equal(h.pending.size, 0);
  const rename = fs.renameSync; let publications = 0;
  const mock = t.mock.method(fs, 'renameSync', (temporary, file) => {
    const next = readJson(temporary);
    assert.equal(next.id, record.id); assert.equal(next.batch.targets.filter(target => target.status === 'released').length, publications + 1);
    publications++; return rename(temporary, file);
  }); syncBuiltinESMExports();
  try {
    for (const target of record.batch.targets) {
      target.status = 'released'; target.text = `RECEIPT ${target.runtimeId}`; saveHumanActionBatch(h.manager, record); h.deliver();
      assert.equal(h.sent.length, 0, 'monitor ticks cannot publish a partially filled batch');
    }
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(publications, 9);
  targets[0].runId = randomUUID(); targets[0].role = 'changed';
  record.batch.complete = true; saveHumanActionBatch(h.manager, record); h.deliver(); h.deliver();
  assert.equal(h.sent.length, 1); assert.deepEqual(h.sent[0].options, { triggerTurn: false });
  assert.deepEqual(h.sent[0].message.details.batch, { total: 9, released: 9, unconfirmed: 0, notAttempted: 0, unknown: 0, interrupted: false });
  assert.equal(h.sent[0].message.details.agentId, undefined, 'a batch is not attributed to just its storage anchor');
  for (const target of before) for (const value of [target.id, target.runId, target.runtimeId]) assert(h.sent[0].message.content.includes(value));
  assert(!fs.readFileSync(path.join(folder, `${record.id}.json`), 'utf8').includes('fixture-only'));
  assert.deepEqual(fs.readdirSync(folder), [`${record.id}.json`]);
});

test('different batches remain separate and synchronous receipt callbacks deduplicate each whole action', () => {
  const h = setup(), a = h.batch(), b = h.batch();
  for (const { record } of [a, b]) {
    record.time = 1;
    for (const item of record.batch.targets) { item.status = 'released'; item.text = 'Native release receipt'; }
    record.batch.complete = true; saveHumanActionBatch(h.manager, record);
  }
  h.pi.sendMessage = (message, options) => { h.sent.push({ message, options }); h.entries.push({ type: 'custom_message', ...message }); h.deliver(); };
  h.deliver(); h.deliver(new Set());
  assert.equal(h.sent.length, 2); assert.deepEqual(new Set(h.sent.map(row => row.message.details.actionId)), new Set([a.record.id, b.record.id]));
  assert.equal(h.pending.size, 0); assert.deepEqual([...deliveredIds(h.ctx)], []);
});

for (const streaming of [false, true]) test(`a complete batch uses one passive SDK message while ${streaming ? 'busy' : 'idle'}`, async () => {
  const h = setup(), { record, file } = h.batch();
  for (const item of record.batch.targets) { item.status = 'released'; item.text = 'Native release receipt'; }
  record.batch.complete = true; saveHumanActionBatch(h.manager, record);
  const { host, calls } = sdkHost(h, streaming);
  h.deliver(); h.deliver(); await Promise.all(calls);
  assert.equal(h.sent.length, 1); assert.equal(host._pendingNextTurnMessages.length, 0);
  if (streaming) {
    assert.equal(host._pendingCustomMessages.length, 1); assert.equal(h.entries.length, 0);
    host._pendingCustomMessages = []; host.isStreaming = false; h.deliver(new Set()); await Promise.all(calls);
    assert.equal(h.sent.length, 2, 'only the unacknowledged notification is replayed');
  }
  assert.equal(h.entries.length, 1); assert.equal(h.entries[0].details.actionId, record.id);
  assert.equal(h.entries[0].details.batch.released, 2); assert.equal(fs.existsSync(file), true);
  h.deliver(new Set()); await Promise.all(calls); assert.equal(h.entries.length, 1);
});

test('a dead batch writer recovers one interrupted notification without inventing unrecorded outcomes', () => {
  const h = setup(), targets = Array.from({ length: 2 }, h.agent), module = new URL('../dist/human-actions.js', import.meta.url).href;
  const id = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const {createHumanActionBatch,saveHumanActionBatch}=await import(${JSON.stringify(module)});
    const manager=${JSON.stringify(h.manager)}, record=createHumanActionBatch(manager,${JSON.stringify(targets)});
    record.batch.targets[0].status='released'; record.batch.targets[0].text='Confirmed first receipt';
    saveHumanActionBatch(manager,record); console.log(record.id);
  `], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
  const file = path.join(h.manager.root, targets[0].id, 'human-actions', `${id}.json`), evidence = fs.readFileSync(file);
  h.current = 'another parent'; h.deliver(); assert.equal(h.sent.length, 0);
  h.current = h.manager.parentFile; h.deliver(); h.deliver();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].message.details.batch, { total: 2, released: 1, unconfirmed: 0, notAttempted: 0, unknown: 1, interrupted: true });
  assert.match(h.sent[0].message.content, /Confirmed first receipt/); assert.match(h.sent[0].message.content, /Outcome was not recorded/);
  assert(h.sent[0].message.content.includes(targets[1].id)); assert.deepEqual(fs.readFileSync(file), evidence);
});

test('unknown batch-writer liveness leaves its evidence pending without blocking a healthy single action', t => {
  const h = setup(), { file } = h.batch(), good = h.add('healthy single action'), evidence = fs.readFileSync(file), kill = process.kill;
  t.mock.method(console, 'error', () => {});
  t.mock.method(process, 'kill', function (pid, signal) { if (pid === process.pid && signal === 0) throw Object.assign(Error('unknown access'), { code: 'EPERM' }); return kill.call(process, pid, signal); });
  h.deliver(); assert.deepEqual(h.sent.map(row => row.message.details.actionId), [good.record.id]);
  assert.deepEqual(fs.readFileSync(file), evidence);
});

test('a failed progress publication keeps the last durable batch and never publishes memory-only success', t => {
  const h = setup(), { record, file } = h.batch(), evidence = fs.readFileSync(file);
  record.batch.targets[0].status = 'released'; record.batch.targets[0].text = 'Actual first outcome';
  const mock = t.mock.method(fs, 'renameSync', () => { throw Error('fixture publication failed'); }); syncBuiltinESMExports();
  try { assert.throws(() => saveHumanActionBatch(h.manager, record), /publication failed/); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(fs.readFileSync(file), evidence); h.deliver(); assert.equal(h.sent.length, 0);
  saveHumanActionBatch(h.manager, record);
  record.batch.targets[1].status = 'not-attempted'; record.batch.targets[1].text = 'Not attempted after parent replacement';
  record.batch.complete = true; saveHumanActionBatch(h.manager, record); h.deliver();
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].message.details.batch.notAttempted, 1);
});

test('malformed batch shapes and foreign members are isolated without consuming their action receipts', t => {
  const h = setup(), { record, file } = h.batch(), good = h.add('healthy sibling');
  for (const item of record.batch.targets) { item.status = 'released'; item.text = 'Native release receipt'; }
  record.batch.complete = true; saveHumanActionBatch(h.manager, record);
  const bad = [
    { ...record.batch, ownerPid: 0 }, { ...record.batch, complete: 'yes' }, { ...record.batch, targets: [] },
    { ...record.batch, targets: [record.batch.targets[0], record.batch.targets[0]] },
    { ...record.batch, targets: record.batch.targets.map(item => ({ ...item, runtimeId: 'bad' })) },
    { ...record.batch, targets: record.batch.targets.map(item => ({ ...item, status: 'pending', text: '' })) },
    { ...record.batch, targets: [record.batch.targets[0], { ...record.batch.targets[1], agentId: randomUUID() }] },
  ];
  const files = bad.map(batch => { const id = `ha-${randomUUID()}`, target = path.join(path.dirname(file), `${id}.json`); writeJson(target, { ...record, id, batch }); return target; });
  const diagnostics = []; t.mock.method(console, 'error', (...args) => diagnostics.push(args));
  h.deliver();
  assert.deepEqual(new Set(h.sent.map(row => row.message.details.actionId)), new Set([record.id, good.record.id]));
  assert.equal(diagnostics.length, files.length); assert(files.every(file => fs.existsSync(file)));
  assert(h.sent.every(row => row.message.details.ids === undefined));
});

test('a linked non-anchor batch member cannot authorize or redirect a batch notification', t => {
  const h = setup(), { record, targets, file } = h.batch();
  for (const item of record.batch.targets) { item.status = 'released'; item.text = 'Native release receipt'; }
  record.batch.complete = true; saveHumanActionBatch(h.manager, record);
  const member = path.join(h.manager.root, targets[1].id), outside = path.join(h.cwd, 'outside-member'), evidence = fs.readFileSync(file);
  fs.renameSync(member, outside); fs.symlinkSync(outside, member, process.platform === 'win32' ? 'junction' : 'dir');
  t.mock.method(console, 'error', () => {});
  try {
    assert.throws(() => saveHumanActionBatch(h.manager, record), /Invalid human-action source/);
    h.deliver(); assert.equal(h.sent.length, 0); assert.deepEqual(fs.readFileSync(file), evidence);
  } finally { fs.unlinkSync(member); }
});

test('human actions atomically publish selected plain fields without serializing an agent or configuration', t => {
  const h = setup(), agent = h.agent(), text = 'Human response: literal 雪\nsecond line';
  agent.configuration = { apiKey: 'fixture-not-a-real-secret' };
  agent.toJSON = () => { throw Error('never serialize the AgentView itself'); };
  const rename = fs.renameSync;
  let published;
  const mock = t.mock.method(fs, 'renameSync', (temporary, file) => {
    assert.equal(fs.existsSync(file), false, 'the final path is not visible before publication');
    published = JSON.parse(fs.readFileSync(temporary, 'utf8'));
    assert.equal(path.basename(file), `${published.id}.json`);
    assert.equal(published.text, text);
    return rename(temporary, file);
  });
  syncBuiltinESMExports();
  let saved;
  try { saved = h.add(text, agent); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(saved.record, published);
  assert.deepEqual(Object.keys(saved.record).sort(), ['agentId', 'id', 'parentFile', 'role', 'runId', 'text', 'time']);
  assert.match(saved.record.id, /^ha-[a-f0-9-]{36}$/);
  assert.equal(saved.record.parentFile, h.manager.parentFile); assert.equal(saved.record.agentId, agent.id);
  assert.equal(saved.record.runId, agent.runId); assert.equal(saved.record.role, 'worker');
  assert.ok(Number.isSafeInteger(saved.record.time));
  assert.deepEqual(fs.readdirSync(path.dirname(saved.file)), [`${saved.record.id}.json`]);
  agent.role = 'changed'; agent.runId = randomUUID();
  assert.equal(readJson(saved.file).role, 'worker', 'the disk record is a value snapshot');
  assert.equal(h.sent.length, 0, 'saving is not delivery and cannot call the original operation');
});

test('a failed atomic publication propagates and leaves no fabricated action to deliver', t => {
  const h = setup(), agent = h.agent();
  const mock = t.mock.method(fs, 'renameSync', () => { throw Object.assign(Error('fixture publication failure'), { code: 'EIO' }); });
  syncBuiltinESMExports();
  try { assert.throws(() => saveHumanAction(h.manager, agent, 'Must not appear as saved'), /publication failure/); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(fs.readdirSync(path.join(h.manager.root, agent.id, 'human-actions')), []);
  h.deliver(); assert.equal(h.sent.length, 0); assert.equal(h.pending.size, 0);
});

test('a saved action waits for its original parent, including a session switch during delivery', () => {
  const h = setup(), a = h.add('first action'), b = h.add('second action');
  h.current = path.join(h.cwd, 'other-parent.jsonl');
  const getEntries = h.ctx.sessionManager.getEntries;
  h.ctx.sessionManager.getEntries = () => { throw Error('must not inspect the unrelated parent'); };
  h.deliver(); assert.equal(h.sent.length, 0); assert.equal(h.pending.size, 0);
  h.ctx.sessionManager.getEntries = getEntries; h.current = h.manager.parentFile;
  h.pi.sendMessage = (message, options) => { h.sent.push({ message, options }); h.current = undefined; };
  h.deliver(); assert.equal(h.sent.length, 1, 'a switched parent must not receive the next action');
  assert.equal(h.pending.size, 1);
  h.current = h.manager.parentFile;
  h.deliver(); assert.equal(h.sent.length, 2);
  assert.deepEqual(new Set(h.sent.map(row => row.message.details.actionId)), new Set([a.record.id, b.record.id]));
  assert.ok(h.sent.every(row => row.message.customType === humanActionType && row.message.display === true));
  assert.ok(h.sent.every(row => row.message.details.ids === undefined));
  assert.ok(fs.existsSync(a.file) && fs.existsSync(b.file));
});

test('whole-session action receipts and pending deduplicate without consuming completion receipt IDs', () => {
  const h = setup(), a = h.add('already stored'), b = h.add('not a completion receipt'), c = h.add('not an ids-array receipt');
  h.entries.push(
    { type: 'custom_message', customType: humanActionType, details: { actionId: a.record.id } },
    { type: 'custom_message', customType: 'cli-subagents-report', details: { ids: [b.record.id], actionId: b.record.id } },
    { type: 'custom_message', customType: humanActionType, details: { ids: [c.record.id] } },
    { type: 'custom', customType: humanActionType, details: { actionId: c.record.id } },
  );
  h.pending.add(a.record.id);
  h.deliver();
  assert.deepEqual(new Set(h.sent.map(row => row.message.details.actionId)), new Set([b.record.id, c.record.id]));
  assert.equal(h.pending.has(a.record.id), false);
  h.deliver(); assert.equal(h.sent.length, 2, 'queued but not persisted must not be queued twice');
  h.entries.push(...h.sent.map(row => ({ type: 'custom_message', ...row.message })));
  h.deliver(); assert.equal(h.pending.size, 0);
  h.deliver(new Set()); assert.equal(h.sent.length, 2);
  assert.deepEqual([...deliveredIds(h.ctx)], [b.record.id], 'human actions never become completion receipts');
  for (const saved of [a, b, c]) assert.ok(fs.existsSync(saved.file), 'acknowledgement does not delete evidence');
});

test('a synchronous sendMessage failure clears pending and retries only the persisted notification', () => {
  const h = setup(), a = h.add(), original = fs.readFileSync(a.file);
  h.pi.sendMessage = () => { throw Error('not accepted by host'); };
  assert.throws(() => h.deliver(), /not accepted by host/);
  assert.equal(h.pending.size, 0); assert.deepEqual(fs.readFileSync(a.file), original);
  h.pi.sendMessage = (message, options) => h.sent.push({ message, options });
  h.deliver(); h.deliver();
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].message.content, a.record.text);
  assert.deepEqual(h.sent[0].options, { triggerTurn: false });
  assert.deepEqual(fs.readdirSync(path.join(h.manager.root, a.agent.id)).sort(), ['human-actions', 'spec.json']);
});

test('synchronous receipt callbacks cannot replay an action from an older delivery scan', () => {
  const h = setup(), a = h.add('first'), b = h.add('second');
  h.pi.sendMessage = (message, options) => {
    h.sent.push({ message, options });
    h.entries.push({ type: 'custom_message', ...message });
    h.deliver(); // Idle SDK append emits message callbacks synchronously.
  };
  h.deliver();
  assert.equal(h.sent.length, 2);
  assert.deepEqual(new Set(h.sent.map(row => row.message.details.actionId)), new Set([a.record.id, b.record.id]));
  assert.equal(h.pending.size, 0);
});

for (const streaming of [false, true]) test(`SDK routing while ${streaming ? 'busy' : 'idle'} never starts or interrupts a model turn`, async () => {
  const h = setup(), a = h.add(), { host, events, calls } = sdkHost(h, streaming);
  h.deliver(); await Promise.all(calls);
  assert.deepEqual(h.sent[0].options, { triggerTurn: false });
  assert.equal(host._pendingNextTurnMessages.length, 0, 'do not require a later user turn to make the action durable');
  if (streaming) {
    assert.equal(h.entries.length, 0); assert.equal(events.length, 0);
    assert.equal(host._pendingCustomMessages.length, 1);
    AgentSession.prototype._flushPendingCustomMessages.call(host);
  }
  assert.equal(h.entries.length, 1); assert.equal(host._pendingCustomMessages.length, 0);
  assert.deepEqual(events.map(event => event.type), ['message_start', 'message_end']);
  assert.equal(h.entries[0].type, 'custom_message'); assert.equal(h.entries[0].details.actionId, a.record.id);
  h.deliver(new Set()); await Promise.all(calls); assert.equal(h.sent.length, 1);
});

test('a busy host queue lost before persistence replays from disk when the original parent reopens', async () => {
  const h = setup(), a = h.add(), { host, calls } = sdkHost(h, true);
  h.deliver(); h.deliver(); await Promise.all(calls);
  assert.equal(host._pendingCustomMessages.length, 1); assert.equal(h.entries.length, 0);
  host._pendingCustomMessages = []; // The old host is gone; this was never a receipt.
  host.isStreaming = false;
  h.deliver(new Set()); await Promise.all(calls);
  assert.equal(h.sent.length, 2); assert.equal(h.entries.length, 1);
  assert.deepEqual(h.sent[0], h.sent[1]); assert.equal(h.entries[0].details.actionId, a.record.id);
  h.deliver(new Set()); await Promise.all(calls); assert.equal(h.sent.length, 2);
});

test('fresh processes recover persisted actions without holding the original manager, context or CLI', () => {
  const h = setup(), agent = h.agent(), module = new URL('../dist/human-actions.js', import.meta.url).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    const {saveHumanAction}=await import(${JSON.stringify(module)});
    saveHumanAction(${JSON.stringify(h.manager)},${JSON.stringify(agent)},'After the original RPC returned');
  `], { windowsHide: true, timeout: 10000 });
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const {deliverHumanActions}=await import(${JSON.stringify(module)});
    const manager=${JSON.stringify(h.manager)}, sent=[];
    deliverHumanActions(manager,{sendMessage:(message,options)=>sent.push({message,options})},
      {sessionManager:{getSessionFile:()=>manager.parentFile,getEntries:()=>[]}},new Set());
    console.log(JSON.stringify(sent));
  `], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const sent = JSON.parse(output);
  assert.equal(sent.length, 1); assert.equal(sent[0].message.content, 'After the original RPC returned');
  assert.equal(sent[0].message.details.runId, agent.runId); assert.deepEqual(sent[0].options, { triggerTurn: false });
});

test('bad shapes and foreign file identities are isolated; repair retries the original action ID', t => {
  const h = setup(), a = h.add('healthy same instance'), b = h.add('healthy sibling'), diagnostics = [];
  t.mock.method(console, 'error', (...args) => diagnostics.push(args));
  const invalid = [null, [], { parentFile: path.join(h.cwd, 'foreign') }, { id: `ha-${randomUUID()}` },
    { agentId: randomUUID() }, { runId: '../outside' }, { role: '' }, { time: -1 }, { time: null },
    { text: { operation: 'stop' } }, { extra: 'not part of the record contract' }];
  const files = invalid.map(patch => {
    const id = `ha-${randomUUID()}`, file = path.join(path.dirname(a.file), `${id}.json`);
    const value = patch === null || Array.isArray(patch) ? patch : { ...a.record, id, ...patch };
    fs.writeFileSync(file, JSON.stringify(value)); return file;
  });
  const id = `ha-${randomUUID()}`, broken = path.join(path.dirname(a.file), `${id}.json`);
  fs.writeFileSync(broken, '{broken'); files.push(broken);
  fs.writeFileSync(`${broken}.tmp`, JSON.stringify({ ...a.record, id }));
  const evidence = files.map(file => fs.readFileSync(file));
  h.deliver();
  assert.deepEqual(new Set(h.sent.map(row => row.message.content)), new Set([a.record.text, b.record.text]));
  assert.equal(diagnostics.length, files.length);
  files.forEach((file, i) => {
    assert.deepEqual(fs.readFileSync(file), evidence[i]);
    assert.ok(diagnostics.some(row => row.join(' ').includes(file)));
  });
  writeJson(broken, { ...a.record, id, text: 'Repaired original action' });
  h.deliver(); assert.equal(h.sent.length, 3);
  assert.equal(h.sent.at(-1).message.details.actionId, id); assert.equal(h.sent.at(-1).message.content, 'Repaired original action');
});

test('saving rejects invalid IDs, bad text and foreign registrations before creating an outbox', () => {
  const h = setup(), agent = h.agent(), folder = path.join(h.manager.root, agent.id, 'human-actions');
  for (const invalid of [{ ...agent, id: '../outside' }, { ...agent, runId: 'bad' }, { ...agent, role: '' }])
    assert.throws(() => saveHumanAction(h.manager, invalid, 'Action'), /Invalid human-action/);
  for (const text of [undefined, {}, '  ']) assert.throws(() => saveHumanAction(h.manager, agent, text), /Invalid human-action/);
  writeJson(path.join(h.manager.root, agent.id, 'spec.json'), { id: agent.id, parentFile: 'foreign' });
  assert.throws(() => saveHumanAction(h.manager, agent, 'Action'), /does not belong/);
  assert.equal(fs.existsSync(folder), false);
});

test('a foreign or unreadable registration cannot block a healthy sibling or authorize its own action', t => {
  const h = setup(), foreign = h.add('wrong owner'), unreadable = h.add('broken registration'), good = h.add('healthy');
  const diagnostics = []; t.mock.method(console, 'error', (...args) => diagnostics.push(args));
  writeJson(path.join(h.manager.root, foreign.agent.id, 'spec.json'), { id: foreign.agent.id, parentFile: 'foreign' });
  fs.writeFileSync(path.join(h.manager.root, unreadable.agent.id, 'spec.json'), '{broken');
  h.deliver();
  assert.deepEqual(h.sent.map(row => row.message.details.actionId), [good.record.id]);
  assert.equal(diagnostics.length, 2);
  assert.ok(fs.existsSync(foreign.file) && fs.existsSync(unreadable.file));
});

for (const level of ['root', 'instance', 'outbox']) test(`linked ${level} cannot redirect human-action reads or writes`, t => {
  const h = setup(), a = h.add('must stay outside the delivery boundary'), diagnostics = [];
  t.mock.method(console, 'error', (...args) => diagnostics.push(args));
  const linked = level === 'root' ? h.manager.root : level === 'instance' ? path.dirname(path.dirname(a.file)) : path.dirname(a.file);
  const outside = path.join(h.cwd, `outside-${level}`);
  fs.renameSync(linked, outside);
  fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const before = fs.readdirSync(outside, { recursive: true }).sort();
  try {
    assert.throws(() => saveHumanAction(h.manager, a.agent, 'must not be written outside'), /Invalid human-action source/);
    h.deliver(); assert.equal(h.sent.length, 0); assert.equal(h.pending.size, 0);
    assert.equal(diagnostics.length, 1);
    assert.deepEqual(fs.readdirSync(outside, { recursive: true }).sort(), before);
  } finally { fs.unlinkSync(linked); }
});
