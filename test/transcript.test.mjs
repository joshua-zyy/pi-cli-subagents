import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TranscriptReader } from '../dist/ui/transcript.js';

const root = path.resolve('.test-output'); fs.mkdirSync(root, { recursive: true });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(root, 'transcript-'));
  const file = path.join(dir, 'events.jsonl'); fs.writeFileSync(file, '');
  const reader = new TranscriptReader();
  const append = (...records) => fs.appendFileSync(file, records.map(r => JSON.stringify(r) + '\n').join(''));
  const read = async (files = [file]) => {
    let snapshot;
    do { snapshot = await reader.read(files); } while (snapshot.loading);
    return snapshot;
  };
  return { reader, file, append, read, dir };
}

test('transcript shows streaming text, tool arguments, partial output and final errors once', async t => {
  const h = fixture(t);
  h.append({ type: 'message_start', message: { role: 'user', content: 'Implement the parser' } },
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Working ' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'on it' } },
    { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'npm test' } },
    { type: 'tool_execution_update', toolCallId: 'c1', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'test in progress' }] } });
  let s = await h.read();
  assert.ok(s.entries.some(e => e.kind === 'user' && e.text === 'Implement the parser'));
  assert.ok(s.entries.some(e => e.kind === 'assistant' && e.text === 'Working on it'));
  let tool = s.entries.find(e => e.kind === 'tool');
  assert.match(tool.input, /npm test/); assert.equal(tool.status, 'running'); assert.equal(tool.text, 'test in progress');
  h.append({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }, { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'npm test' } }] } },
    { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', isError: true, result: { content: [{ type: 'text', text: 'one test failed' }] } },
    { type: 'message_end', message: { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'one test failed' }] } });
  s = await h.read();
  assert.equal(s.entries.filter(e => e.kind === 'assistant').length, 1);
  assert.equal(s.entries.filter(e => e.kind === 'tool').length, 1);
  tool = s.entries.find(e => e.kind === 'tool'); assert.equal(tool.status, 'error'); assert.equal(tool.text, 'one test failed');
  assert.equal(s.entries.find(e => e.kind === 'assistant').text, 'Working on it.');
});

test('supports cumulative RPC snapshots, split UTF-8 records and multiple runs', async t => {
  const h = fixture(t);
  h.append({ type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'Snapshot text' }] } });
  await h.read();
  const bytes = Buffer.from(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '\u4f60\u597d\u2028world' }] } }) + '\n');
  const split = bytes.indexOf(Buffer.from('\u4f60')) + 1;
  fs.appendFileSync(h.file, bytes.subarray(0, split)); await h.read();
  fs.appendFileSync(h.file, bytes.subarray(split));
  let s = await h.read(); assert.equal(s.entries.filter(e => e.kind === 'assistant').at(-1).text, '\u4f60\u597d\u2028world');
  const next = path.join(h.dir, 'next.jsonl'); fs.writeFileSync(next, JSON.stringify({ type: 'message_end', message: { role: 'user', content: 'Continue in the same session' } }) + '\n');
  s = await h.read([h.file, next]);
  assert.equal(s.entries.filter(e => e.kind === 'notice' && e.title.startsWith('Run')).length, 2);
  assert.ok(s.entries.some(e => e.text === 'Continue in the same session'));
  assert.ok(s.entries.some(e => e.text === '\u4f60\u597d\u2028world'));
});

test('missing files, malformed records and bounded history produce visible notices', async t => {
  const h = fixture(t);
  const missing = path.join(h.dir, 'missing.jsonl');
  let s = await h.read([missing]); assert.match(s.notice, /unavailable|not available/i);
  fs.appendFileSync(h.file, 'bad JSON\n');
  for (let i = 0; i < 350; i++) h.append({ type: 'message_end', message: { role: 'user', content: `Task ${i}` } });
  s = await h.read();
  assert.ok(s.entries.length <= 300);
  assert.match(s.notice, /older|recent/i);
  assert.ok(s.entries.some(e => e.text === 'Task 349'));
});

test('clearing history advances the revision so the UI cannot retain stale lines', async t => {
  const h = fixture(t);
  h.append({ type: 'message_end', message: { role: 'assistant', content: 'OLD-CONTENT' } });
  const before = await h.read();
  const cleared = await h.read([]);
  assert.equal(cleared.entries.length, 0);
  assert.ok(cleared.revision > before.revision);
});

test('the final assistant remains visible after entry eviction and interaction details are retained', async t => {
  const h = fixture(t);
  h.append({ type: 'message_start', message: { role: 'assistant', content: [] } });
  for (let i = 0; i < 310; i++) h.append({ type: 'tool_execution_start', toolCallId: String(i), toolName: 'read', args: {} });
  h.append({ type: 'message_end', message: { role: 'assistant', content: 'FINAL' } },
    { type: 'extension_ui_request', method: 'select', id: 'q1', title: 'Permission question', message: 'Exact operation details', options: ['Block', 'Allow once'] });
  const s = await h.read();
  assert.ok(s.entries.some(e => e.kind === 'assistant' && e.text === 'FINAL'));
  const q = s.entries.find(e => e.title.includes('Interaction'));
  assert.match(q.text, /Exact operation details/); assert.match(q.text, /Allow once/);
});
