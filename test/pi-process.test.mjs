import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiProcess } from '../dist/pi-process.js';
import { waitUntil } from '../dist/storage.js';
import { tempDir } from './helpers/tmp.mjs';
const fixture = fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url));

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
