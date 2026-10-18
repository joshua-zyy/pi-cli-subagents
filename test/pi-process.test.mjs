import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PiProcess } from '../dist/pi-process.js';
import { waitUntil, readJson } from '../dist/storage.js';
import { tempDir } from './helpers/tmp.mjs';
const fixture = fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url));

for (const scenario of ['chunks', 'normal-prefix', 'complete-record']) test(`Pi rejects oversized native records: ${scenario}`, { timeout: 10000 }, async t => {
  const { rpc } = gated(t); await rpc.request({ type: 'get_state' });
  const chunks = scenario === 'chunks' ? Array(8).fill('雪'.repeat(180000)) : scenario === 'normal-prefix'
    ? [JSON.stringify({ type: 'notice' }) + '\n' + 'x'.repeat(4 * 1024 * 1024 + 1)]
    : [JSON.stringify({ type: 'notice', text: '雪'.repeat(1500000) }) + '\n'];
  await assert.rejects(rpc.request({ type: 'fixture/raw', chunks }), /Pi RPC record exceeds 4 MiB/);
  await rpc.closed;
  await assert.rejects(rpc.request({ type: 'prompt', message: 'must not run' }), /Pi RPC record exceeds 4 MiB/);
});

test('Pi initial handled input releases its run reservation without a terminal event', async t => {
  const { rpc, records } = gated(t);
  const handled = rpc.request({ type: 'prompt', message: 'HANDLED' }), captured = rpc.run;
  assert.equal((await handled).disposition, 'handled');
  assert.equal(rpc.run, undefined);
  await Promise.race([captured.done, new Promise((_, reject) => setTimeout(() => reject(Error('handled run still reserved')), 100))]);
  assert.equal(records.some(r => r.type === 'agent_settled'), false);
  await rpc.request({ type: 'prompt', message: 'after handled' });
  await waitUntil('next run settles', () => records.some(r => r.type === 'agent_settled'));
});

function gated(t) {
  const cwd = tempDir('pi-in-flight'), records = [];
  const rpc = new PiProcess({ command: process.execPath, args: [fixture] }, ['--session-dir', cwd], cwd, path.join(cwd, 'events.jsonl'), e => records.push(e), 1500);
  t.after(() => rpc.stop());
  const native = () => readJson(path.join(cwd, 'fake-session.json'));
  const input = (key, message, outcome, timeout) => {
    const pending = rpc.request({ type: 'prompt', streamingBehavior: 'steer',
      message: 'DEFER_INPUT ' + JSON.stringify({ key, message, outcome }) }, timeout);
    // Preserve the original promise for assertions; cleanup after an earlier assertion
    // must not turn another held input into an unrelated unhandled rejection.
    void pending.catch(() => {}); return pending;
  };
  const release = key => fs.writeFileSync(path.join(cwd, `input-${key}.release`), '');
  return { rpc, records, native, input, release };
}

test('Pi waits for all in-flight inputs, including handled input after a newer native terminal', async t => {
  const { rpc, records, native, input, release } = gated(t);
  await rpc.request({ type: 'prompt', message: 'HOLD A' }); const captured = rpc.run;
  const first = input('one', 'B done'), second = input('two', '', 'handled');
  await waitUntil('native A settled', () => native()?.fixtureSettledCount === 1);
  release('one'); assert.equal((await first).disposition, 'started');
  await waitUntil('native B settled before the other preflight returned', () => native()?.fixtureSettledCount === 2);
  assert.equal(rpc.run, captured);
  assert.equal(records.filter(r => r.type === 'agent_settled').length, 0);
  assert.equal(native().fixtureStateReads ?? 0, 0, 'do not query native idle while an input is still in flight');
  release('two'); assert.equal((await second).disposition, 'handled');
  await waitUntil('assignment settled once', () => records.filter(r => r.type === 'agent_settled').length === 1);
  assert.equal(native().fixtureStateReads, 1, 'one final check after all input outcomes are known, no polling');
  assert.equal(records.filter(r => r.type === 'message_end').at(-1).message.content[0].text, 'B done');
  assert.equal(captured.inFlightInputs, 0); assert.equal(rpc.pending.size, 0);
  await rpc.request({ type: 'prompt', message: 'third task' });
  await waitUntil('new assignment settled', () => records.filter(r => r.type === 'agent_settled').length === 2);
  assert.deepEqual(native().fixtureInputRequests, ['one', 'two']);
});

test('Pi keeps queued native work captured until queue drain and a terminal, without polling', async t => {
  const {rpc,records,native,input,release}=gated(t);
  await rpc.request({type:'prompt',message:'HOLD A'});const captured=rpc.run;
  const queued=input('queued','B done','queued');
  await waitUntil('native A settled',()=>native()?.fixtureSettledCount===1);release('queued');
  assert.equal((await queued).disposition,'queued');
  await rpc.request({type:'get_messages'});
  assert.equal(rpc.run,captured);assert.equal(records.filter(r=>r.type==='agent_settled').length,0);
  assert.equal(native().fixtureStateReads,1,'one idle check observes a pending native queue');
  await rpc.request({type:'fixture/pending',count:0});
  rpc.child.stdin.write(JSON.stringify({type:'fixture/finish',text:'B done'})+'\n');
  await waitUntil('drained assignment settled',()=>records.filter(r=>r.type==='agent_settled').length===1);
  assert.equal(native().fixtureStateReads,2,'only the later terminal causes another check');
  assert.equal(records.filter(r=>r.type==='message_end').at(-1).message.content[0].text,'B done');
});

test('Pi does not settle an initial prompt before its acknowledgement callback completes', async t => {
  const {rpc,records}=gated(t), arrived=Promise.withResolvers();
  const record=rpc.record.bind(rpc);
  t.mock.method(rpc,'record',event=>{record(event);if(event.type==='agent_settled')arrived.resolve();});
  const first=rpc.request({type:'prompt',message:'initial result'}),captured=rpc.run;void first.catch(()=>{});
  const entry=rpc.pending.values().next().value,resolve=entry.resolve;let acknowledge;
  entry.resolve=value=>{acknowledge=()=>resolve(value);};
  try {
    await arrived.promise;await rpc.request({type:'get_messages'});
    assert.equal(captured.inFlightInputs,1);assert.equal(rpc.run,captured);
    assert.equal(records.filter(r=>r.type==='agent_settled').length,0);
  } finally {acknowledge?.();}
  await first;await waitUntil('initial prompt settled once',()=>records.filter(r=>r.type==='agent_settled').length===1);
});

test('Pi rejected preflight drains only that input and does not poison another accepted input', async t => {
  const { rpc, records, native, input, release } = gated(t);
  await rpc.request({ type: 'prompt', message: 'HOLD A' }); const captured = rpc.run;
  const rejection = assert.rejects(input('reject', '', 'reject'), /preflight rejected/);
  const accepted = input('accept', 'B done');
  await waitUntil('native A settled', () => native()?.fixtureSettledCount === 1);
  release('reject'); await rejection;
  assert.equal(rpc.poisoned, undefined); assert.equal(rpc.run, captured); assert.equal(captured.inFlightInputs, 1);
  assert.equal(records.some(r => r.type === 'agent_settled'), false);
  release('accept'); await accepted;
  await waitUntil('accepted input settled', () => records.filter(r => r.type === 'agent_settled').length === 1);
  assert.equal(captured.inFlightInputs, 0); assert.equal(rpc.pending.size, 0);
  await rpc.request({ type: 'prompt', message: 'third task' });
  await waitUntil('third task settled', () => records.filter(r => r.type === 'agent_settled').length === 2);
  assert.deepEqual(native().fixtureInputRequests, ['reject', 'accept']);
});

test('Pi input timeout poisons before deferred validation and late acknowledgements cannot release the capture', async t => {
  const { rpc, records, native, input, release } = gated(t);
  await rpc.request({ type: 'prompt', message: 'HOLD A' }); const captured = rpc.run;
  const timeout = assert.rejects(input('timeout', '', 'handled', 300), /timed out.*uncertain/);
  const other = input('other', '', 'handled');
  await timeout; release('timeout'); release('other'); await other;
  assert(rpc.poisoned); assert.equal(rpc.run, captured); assert.equal(captured.inFlightInputs, 0);
  assert.equal(rpc.pending.size, 0); assert.equal(records.some(r => r.type === 'agent_settled'), false);
  assert.equal(native().fixtureStateReads ?? 0, 0, 'poisoned runtimes cannot validate their way back to idle');
  await assert.rejects(rpc.request({ type: 'prompt', message: 'no replay' }), /uncertain/);
  await assert.rejects(rpc.request({ type: 'prompt', message: 'no steer', streamingBehavior: 'steer' }), /uncertain/);
  assert.equal((await rpc.stop()).exit.code, 0); assert.deepEqual(native().fixtureInputRequests, ['timeout', 'other']);
});

test('Pi validates a newer native terminal that arrived during the previous state snapshot', async t => {
  const { rpc, records, native, input, release } = gated(t);
  const request = rpc.request.bind(rpc), held = Promise.withResolvers(), releaseSnapshot = Promise.withResolvers();
  let once = true;
  t.mock.method(rpc, 'request', async (cmd, ...rest) => {
    const result = await request(cmd, ...rest);
    if (cmd.type === 'get_state' && once) { once = false; held.resolve(result); await releaseSnapshot.promise; }
    return result;
  });
  try {
    await rpc.request({ type: 'prompt', message: 'HOLD A' }); const pending = input('b', 'HOLD B');
    await waitUntil('native A terminal', () => native()?.fixtureSettledCount === 1); release('b'); await pending;
    assert.equal((await held.promise).isStreaming, true);
    rpc.child.stdin.write(JSON.stringify({ type: 'fixture/finish', text: 'B done' }) + '\n');
    await waitUntil('B terminal while previous snapshot is held', () => native()?.fixtureSettledCount === 2);
    await rpc.request({ type: 'get_messages' }); // Ordered wire barrier, not another idle query.
    assert.equal(records.some(r => r.type === 'agent_settled'), false);
  } finally { releaseSnapshot.resolve(); }
  await waitUntil('new terminal validated', () => records.filter(r => r.type === 'agent_settled').length === 1);
  assert.equal(native().fixtureStateReads, 2);
  assert.equal(records.filter(r => r.type === 'message_end').at(-1).message.content[0].text, 'B done');
});

test('Pi does not publish a validation response after the captured runtime is poisoned', async t => {
  const { rpc, records } = gated(t); const request = rpc.request.bind(rpc);
  const held = Promise.withResolvers(), release = Promise.withResolvers();
  t.mock.method(rpc, 'request', async (cmd, ...rest) => {
    const result = await request(cmd, ...rest);
    if (cmd.type === 'get_state') { held.resolve(); await release.promise; }
    return result;
  });
  await rpc.request({ type: 'prompt', message: 'A done' }); await held.promise;
  const write = rpc.child.stdin.write;
  try {
    rpc.child.stdin.write = (_chunk, callback) => { queueMicrotask(() => callback(new Error('uncertain UI write'))); return true; };
    await assert.rejects(rpc.reply({ id: 'fixture-dialog', cancelled: true }), /uncertain/);
  } finally { rpc.child.stdin.write = write; release.resolve(); }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(records.some(r => r.type === 'agent_settled'), false); assert(rpc.run);
});

test('Pi interrupt stays bound to the old token when the turn settles before clear_queue responds', async t => {
  const cwd = tempDir('pi-interrupt-token'), records = [];
  const rpc = new PiProcess({ command: process.execPath, args: [fixture] }, ['--session-dir', cwd], cwd, path.join(cwd, 'events.jsonl'), e => records.push(e), 1500);
  t.after(() => rpc.stop());
  const held = Promise.withResolvers(), release = Promise.withResolvers(), requests = [];
  const request = rpc.request.bind(rpc); let holdOnce = true;
  t.mock.method(rpc, 'request', async (cmd, ...rest) => {
    requests.push(cmd.type);
    const result = await request(cmd, ...rest);
    if (cmd.type === 'clear_queue' && holdOnce) {
      holdOnce = false; held.resolve(); await release.promise;
    }
    return result;
  });
  await rpc.request({ type: 'prompt', message: 'old-result' });
  const interrupt = rpc.interrupt();
  try {
    await held.promise;
    await waitUntil('old turn settled while queue response held', () => records.some(r => r.type === 'agent_settled'));
    await assert.rejects(rpc.request({ type: 'prompt', message: 'too-early' }), /interrupt/i);
  } finally { release.resolve(); }
  await interrupt;
  assert.equal(requests.includes('abort'), false, 'the old interrupt must not abort an already-ended run');
  await rpc.request({ type: 'prompt', message: 'new-result' });
  await waitUntil('new turn settled', () => records.filter(r => r.type === 'agent_settled').length === 2);
  assert.deepEqual(records.filter(r => r.type === 'message_end').map(r => r.message.content[0].text), ['old-result', 'new-result']);
});
test('Pi process interrupt waits for settled, stop still clears queues and releases resources', async t => {
  const cwd = tempDir('pi-process'), records = [];
  const rpc = new PiProcess({ command: process.execPath, args: [fixture] }, ['--session-dir', cwd], cwd, path.join(cwd, 'events.jsonl'), e => records.push(e), 500);
  t.after(() => rpc.stop());
  const requests = [], request = rpc.request.bind(rpc);
  rpc.request = (cmd, ...rest) => { requests.push(cmd.type); return request(cmd, ...rest); };
  await rpc.request({ type: 'get_state' }); await rpc.request({ type: 'prompt', message: 'HOLD' });
  await rpc.interrupt();
  assert(records.some(r => r.type === 'agent_settled'));
  assert.equal(rpc.child.exitCode, null);
  await rpc.request({ type: 'prompt', message: 'UNICODE' });
  await waitUntil('second settled', () => records.filter(r => r.type === 'agent_settled').length === 2);
  assert.equal(records.filter(r => r.type === 'message_end').at(-1).message.content[0].text, 'A\u2028B\u2029雪');
  const before = requests.length;
  assert.equal((await rpc.stop()).exit.code, 0);
  assert(requests.slice(before).includes('clear_queue'));
  await assert.rejects(rpc.request({ type: 'prompt', message: 'closed' }), /closed|closing|exit|ended/i);
});
