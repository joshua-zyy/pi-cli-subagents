import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiAdapter } from '../dist/pi-adapter.js';
import { waitUntil } from '../dist/storage.js';
import { tempDir } from './helpers/tmp.mjs';
const fixture = fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url));

test('Pi handled initial input is reported without claiming model execution', async t => {
  const { c, events } = setup(t); await c.ready();
  await assert.rejects(c.start('HANDLED', 'handled'), /handled.*no native run/i);
  assert.equal(events.some(e => e.type === 'settled'), false);
  await c.start('after handled', 'next');
  assert.equal((await settled(events, 'next')).status, 'completed');
});
function setup(t, flags = []) {
  const cwd = tempDir('pi-adapter'), events = [];
  fs.mkdirSync(path.join(cwd, 'runs', 'one'), { recursive: true });
  const c = new PiAdapter({ spec: { id: 'fixture', cwd, roleName: 'worker', role: { instructions: 'Only fixture work.' },
    launch: { command: process.execPath, args: [fixture, ...flags] } }, logFile: path.join(cwd, 'runs', 'one', 'events.jsonl'),
    onEvent: e => events.push(e), requestTimeout: 750 });
  t.after(() => c.stop());
  return { c, events };
}
const settled = (events, runId) => waitUntil('Pi terminal', () => events.find(e => e.type === 'settled' && e.runId === runId), 3000);
const inject = (c, records) => c.rpc.child.stdin.write(JSON.stringify({ type: 'fixture/emit', records }) + '\n');

test('Pi startup dialogs can be answered before ready completes and never submit a model prompt', async t => {
  const { c, events } = setup(t, ['--startup-dialog']);
  let readyDone = false;
  const ready = c.ready().then(session => { readyDone = true; return session; });
  void ready.catch(() => {});
  const q = await waitUntil('startup dialog before ready', () => events.find(e => e.type === 'question'), 500);
  assert.equal(readyDone, false); assert.equal(q.runId, undefined);
  assert.equal(q.question.method, 'confirm'); assert.deepEqual(q.question.parentPolicy, { confirm: true });
  assert.equal(q.question.humanOnly, false);
  await c.reply({ type: 'reply', id: q.question.id, confirmed: false });
  const session = await ready;
  assert.deepEqual((await c.rpc.request({ type: 'get_messages' })).messages, []);
  assert.equal(JSON.parse(fs.readFileSync(session.sessionFile)).fixtureReplies[0].confirmed, false);
  assert(events.some(e => e.type === 'resolved' && e.id === q.question.id && e.runId === undefined));
  await c.start('original-task', 'one'); assert.equal((await settled(events, 'one')).text, 'original-task');
});

test('Pi keeps startup dialogs that outlive ready pending across the first task', async t => {
  const { c, events } = setup(t, ['--startup-dialog-after-state']); const session = await c.ready();
  const q = await waitUntil('startup dialog after state', () => events.find(e => e.type === 'question'), 500);
  await c.start('original-task', 'one'); await settled(events, 'one');
  assert(!events.some(e => e.type === 'resolved' && e.id === q.question.id));
  await c.reply({ type: 'reply', id: q.question.id, cancelled: true });
  await c.rpc.request({ type: 'get_state' });
  assert.equal(JSON.parse(fs.readFileSync(session.sessionFile)).fixtureReplies[0].cancelled, true);
  assert(events.some(e => e.type === 'resolved' && e.id === q.question.id && e.runId === undefined));
});

test('Pi idle ordinary dialogs retain shape, pending identity and independent scope through another run', async t => {
  const { c, events } = setup(t); const session = await c.ready();
  await c.start('first', 'one'); await settled(events, 'one');
  const dialogs = [
    { id: 'idle-select', method: 'select', title: 'Choose', options: ['Block', 'Allow once', 'Always allow in this cwd'] },
    { id: 'idle-confirm', method: 'confirm', title: 'Confirm', message: 'Fixture-only choice' },
    { id: 'idle-input', method: 'input', title: 'Context', placeholder: 'exact text' },
    { id: 'idle-editor', method: 'editor', title: 'Edit', prefill: 'original\ncontext' },
  ];
  for (const dialog of dialogs) c.rpc.child.stdin.write(JSON.stringify({ type: 'fixture/dialog', dialog }) + '\n');
  await waitUntil('independent dialogs', () => events.filter(e => e.type === 'question').length === 4, 500);
  for (const { question, runId } of events.filter(e => e.type === 'question')) {
    const native = dialogs.find(d => d.id === question.id);
    assert.equal(runId, undefined); assert.equal(question.humanOnly, false);
    for (const field of ['id', 'method', 'title', 'options', 'message', 'placeholder', 'prefill']) assert.deepEqual(question[field], native[field]);
  }
  inject(c, [{ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'stale' }], stopReason: 'stop' } }, { type: 'agent_settled' }]);
  await c.rpc.request({ type: 'get_state' });
  assert.notEqual(c.assistant?.content?.[0]?.text, 'stale', 'idle assistant frames must not repopulate a run cache');
  await c.start('second', 'two'); assert.equal((await settled(events, 'two')).text, 'second');
  assert(!events.some(e => e.type === 'resolved' && e.id.startsWith('idle-')));
  const answers = [{ value: 'Block' }, { confirmed: false }, { value: 'literal context' }, { value: 'line one\nline two' }];
  for (const [index, dialog] of dialogs.entries()) {
    await c.reply({ type: 'reply', id: dialog.id, ...answers[index] });
    await assert.rejects(c.reply({ type: 'reply', id: dialog.id, ...answers[index] }), /pending|answered/);
  }
  await c.rpc.request({ type: 'get_state' });
  assert.deepEqual(JSON.parse(fs.readFileSync(session.sessionFile)).fixtureReplies,
    dialogs.map((d, i) => ({ id: d.id, ...answers[i], type: 'extension_ui_response' })));
  assert(events.filter(e => e.type === 'resolved' && e.id.startsWith('idle-')).every(e => e.runId === undefined));
  assert.equal(events.filter(e => e.type === 'settled').length, 2);
});

test('Pi resident keeps PID and session across rounds, resets text/questions and tags every event', async t => {
  const { c, events } = setup(t); const session = await c.ready(), pid = c.pid;
  assert.equal(c.resident, true);
  await c.start('REMEMBER alpha', 'one'); assert.equal((await settled(events, 'one')).text, 'OK');
  const firstCount = events.length;
  await c.start('RECALL', 'two'); assert.equal((await settled(events, 'two')).text, 'alpha');
  assert.equal(c.pid, pid); assert.deepEqual(await c.ready(), session);
  assert(events.slice(0, firstCount).every(e => e.runId === 'one'));
  assert(events.slice(firstCount).every(e => e.runId === 'two'));
  await c.start('WAIT', 'three');
  const q = await waitUntil('Pi question', () => events.find(e => e.type === 'question' && e.runId === 'three'));
  await c.interrupt(); assert.equal((await settled(events, 'three')).status, 'stopped');
  await assert.rejects(c.reply({ type: 'reply', id: q.question.id, confirmed: true }), /pending|active|ended/i);
  await c.start('FAIL', 'four'); const failed = await settled(events, 'four');
  assert.equal(failed.status, 'failed'); assert.equal(failed.text, '');
  assert(events.some(e => e.type === 'resolved' && e.runId === 'three'));
  assert.equal((await c.end()).exit.code, 0);
});

test('Pi ignores duplicate old terminal while idle and during a later active round', async t => {
  const { c, events } = setup(t); await c.ready(); await c.start('first', 'one'); await settled(events, 'one');
  inject(c, [{ type: 'agent_settled' }]);
  await c.start('HOLD', 'two');
  inject(c, [{ type: 'agent_settled' }]);
  await c.rpc.request({ type: 'get_state' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(events.filter(e => e.type === 'settled').length, 1);
  await c.interrupt(); assert.equal((await settled(events, 'two')).status, 'stopped');
});

test('Pi rejects busy send locally while terminal validation is pending without poisoning or losing the old result', async t => {
  const { c, events } = setup(t); await c.ready();
  const held = Promise.withResolvers(), release = Promise.withResolvers();
  const request = c.rpc.request.bind(c.rpc); let holdOnce = true;
  // Hold a real native get_state response after the child has gone idle. A prompt
  // written in this window would be accepted as a new native run, not a steer.
  t.mock.method(c.rpc, 'request', async (command, ...rest) => {
    const result = await request(command, ...rest);
    if (command.type === 'get_state' && holdOnce) {
      holdOnce = false; held.resolve(result); await release.promise;
    }
    return result;
  });
  try {
    await c.start('old-result', 'one');
    assert.equal((await held.promise).isStreaming, false);
    assert.equal(c.rpc.run.validating, true);
    for (const mode of ['steer', 'followUp']) await assert.rejects(c.send('must-not-start', mode), /validat|settling|terminal/i);
    await assert.rejects(c.start('must-not-replace', 'two'), /active|validat|settling|terminal/i);
    const native = await request({ type: 'get_messages' });
    assert.deepEqual(native.messages.filter(m => m.role === 'user').map(m => m.content), ['old-result']);
    assert.equal(c.rpc.poisoned, undefined, 'local admission rejection is not uncertain delivery');
    assert.equal(events.some(e => e.type === 'settled'), false);
  } finally { release.resolve(); }
  assert.equal((await settled(events, 'one')).text, 'old-result');
  await c.start('next-result', 'two'); assert.equal((await settled(events, 'two')).text, 'next-result');
  assert.equal(events.filter(e => e.type === 'settled').length, 2);
});

test('Pi concurrent interrupt is idempotent, blocks new work and does not close the process', async t => {
  const { c, events } = setup(t); await c.ready(); await c.start('HOLD', 'one');
  const a = c.interrupt(), b = c.interrupt();
  await assert.rejects(c.start('wrong', 'two'), /interrupt|active|ready/i);
  await assert.rejects(c.send('wrong', 'steer'), /interrupt/i);
  await Promise.all([a, b]); assert.equal((await settled(events, 'one')).status, 'stopped');
  assert.equal(c.rpc.child.exitCode, null);
  await c.start('next', 'two'); assert.equal((await settled(events, 'two')).text, 'next');
});

test('Pi logical answer write failure settles once and cannot be followed by another run', async t => {
  const { c, events } = setup(t); await c.ready(); await c.start('ASK_PARENT', 'one');
  const q = await waitUntil('logical question', () => events.find(e => e.type === 'question'));
  await waitUntil('native dialog', () => [...c.parentCalls.values()].some(call => call.deferred));
  const write = c.rpc.child.stdin.write;
  c.rpc.child.stdin.write = (_chunk, callback) => { queueMicrotask(() => callback(new Error('fixture uncertain write'))); return true; };
  try { await assert.rejects(c.reply({ type: 'reply', id: q.question.id, value: 'Unit' }), /uncertain write/); }
  finally { c.rpc.child.stdin.write = write; }
  assert.equal((await settled(events, 'one')).status, 'failed');
  c.rpc.child.stdin.write(JSON.stringify({ type: 'abort' }) + '\n');
  await waitUntil('native idle', async () => !(await c.rpc.request({ type: 'get_state' })).isStreaming);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(events.filter(e => e.type === 'settled').length, 1);
  await assert.rejects(c.start('must not replay', 'two'), /uncertain|stop|release/i);
});

test('Pi logical question answers and final-message state do not carry into the next round', async t => {
  const { c, events } = setup(t); await c.ready();
  for (const [runId, value] of [['one', 'Unit'], ['two', 'Integration']]) {
    await c.start('ASK_PARENT', runId);
    const q = await waitUntil('logical question', () => events.find(e => e.type === 'question' && e.runId === runId));
    await c.reply({ type: 'reply', id: q.question.id, value });
    const result = await settled(events, runId);
    assert(result.text.includes(value)); assert.equal(result.status, 'completed');
    assert.equal(events.filter(e => e.type === 'question' && e.runId === runId).length, 1);
    assert.equal(events.filter(e => e.type === 'resolved' && e.runId === runId).length, 1);
  }
});

test('Pi ambiguous interrupt poisons the runtime until resource release, even after late completion', async t => {
  for (const flag of ['--ignore-interrupt', '--ack-interrupt-only']) {
    const { c, events } = setup(t, [flag]); await c.ready(); await c.start('HOLD', 'one');
    await assert.rejects(c.interrupt(), /uncertain|timed out/i);
    // A later genuine idle/terminal must not silently rehabilitate an uncertain runtime.
    c.rpc.child.stdin.write(JSON.stringify({ type: 'prompt', message: 'late', streamingBehavior: 'steer' }) + '\n');
    await waitUntil('late native terminal in the wire log', () => fs.readFileSync(c.options.logFile, 'utf8').includes('"type":"agent_settled"'));
    assert.equal((await c.rpc.request({ type: 'get_state' })).isStreaming, false);
    assert.equal(events.some(e => e.type === 'settled'), false, 'poisoned validation cannot publish an idle assignment');
    await assert.rejects(c.start('must not replay', 'two'), /uncertain|poison|stop|release/i);
    await assert.rejects(c.send('must not inject', 'steer'), /uncertain|poison|stop|release/i);
    assert.equal((await c.stop()).exit.code, 0);
  }
});

test('Pi activity names the tool instead of the raw native event type', async t => {
  const { c, events } = setup(t); await c.ready();
  await c.start('STREAM', 'one'); await settled(events, 'one');
  const labels = events.filter(e => e.type === 'activity').map(e => e.detail);
  assert.deepEqual(labels, ['Starting', 'Using read', 'Finished read']);
  await c.stop();
});
