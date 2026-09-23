import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiProcess } from '../dist/pi-process.js';
import { loadRoles } from '../dist/roles.js';
import { writeJson, waitUntil } from '../dist/storage.js';

export const fixture = fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url));
const output = path.resolve('.test-output');
fs.mkdirSync(output, { recursive: true });
const temp = () => fs.mkdtempSync(path.join(output, 'unit-'));

test('RPC correlates requests, preserves Unicode separators, and surfaces rejection', async () => {
  const dir = temp(); const events = [];
  const rpc = new PiProcess({ command: process.execPath, args: [fixture] }, ['--session-dir', dir], dir, path.join(dir, 'events.jsonl'), (r) => events.push(r));
  try {
    const [state, history] = await Promise.all([rpc.request({ type: 'get_state' }), rpc.request({ type: 'get_messages' })]);
    assert.ok(state.sessionId); assert.deepEqual(history.messages, []);
    await assert.rejects(rpc.request({ type: 'prompt', message: 'REJECT' }), /rejected/);
    await rpc.request({ type: 'prompt', message: 'UNICODE' });
    await waitUntil('settled', () => events.find(e => e.type === 'agent_settled'));
    assert.equal(events.find(e => e.type === 'message_end').message.content[0].text, 'A\u2028B\u2029雪');
  } finally { assert.equal((await rpc.end()).exit.code, 0); }
});

test('role settings inherit defaults; untrusted project files are not loaded', () => {
  const user = temp(), cwd = temp();
  writeJson(path.join(user, 'cli-subagents.roles.json'), { custom: { description: 'global', instructions: 'do work', model: 'chosen' } });
  writeJson(path.join(cwd, '.pi/cli-subagents.roles.json'), { custom: { description: 'project', instructions: 'project work', thinking: 'high' } });
  assert.equal(loadRoles(user, cwd, false).custom.model, 'chosen');
  assert.equal(loadRoles(user, cwd, true).custom.description, 'project');
  assert.equal(loadRoles(user, cwd, true).worker.model, undefined);
  writeJson(path.join(cwd, '.pi/cli-subagents.roles.json'), { custom: { description: 'bad', instructions: 'bad', models: 'typo' } });
  assert.throws(() => loadRoles(user, cwd, true), /未知字段/);
});
