import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TranscriptReader } from '../dist/ui/transcript.js';
const root = path.resolve('.test-output'); fs.mkdirSync(root, { recursive: true });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(root, 'codex-transcript-'));
  const file = path.join(dir, 'run-1.jsonl'); fs.writeFileSync(file, '');
  const reader = new TranscriptReader('codex', 'thread-1');
  const append = (...records) => fs.appendFileSync(file, records.map(record => JSON.stringify(record) + '\n').join(''));
  const read = async (files = [file]) => { let result; do { result = await reader.read(files); } while (result.loading); return result; };
  const event = (method, params) => ({ method, params: { threadId: 'thread-1', turnId: 'turn-1', ...params } });
  return { dir, file, append, read, event };
}
const usage = (input, cached, output) => ({ inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: 0, totalTokens: input + output });

test('Codex transcript merges live deltas and final items, tool output, file changes and Unicode', async t => {
  const h = fixture(t), { event } = h;
  h.append({ id: 2, result: { model: 'gpt-6-luna', modelProvider: 'openai', thread: { id: 'thread-1' } } },
    event('item/completed', { item: { type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'Read 雪\u2028now' }] } }),
    event('item/agentMessage/delta', { itemId: 'answer-1', delta: 'Working ' }),
    event('item/agentMessage/delta', { itemId: 'answer-1', delta: 'on it' }),
    event('item/started', { item: { type: 'commandExecution', id: 'shell-1', command: 'echo snow', cwd: '/tmp', status: 'inProgress' } }),
    event('item/commandExecution/outputDelta', { itemId: 'shell-1', delta: 'snow\n' }),
    event('item/started', { item: { type: 'fileChange', id: 'patch-1', status: 'inProgress', changes: [{ path: '/tmp/file', kind: 'update', diff: '+line' }] } }));
  let snapshot = await h.read();
  assert.equal(snapshot.model, 'gpt-6-luna');
  assert.equal(snapshot.entries.find(e => e.kind === 'user').text, 'Read 雪\u2028now');
  assert.equal(snapshot.entries.find(e => e.kind === 'assistant').text, 'Working on it');
  assert.equal(snapshot.entries.find(e => e.id.endsWith('shell-1')).status, 'running');
  assert.match(snapshot.entries.find(e => e.id.endsWith('patch-1')).input, /\/tmp\/file/);
  h.append(event('item/completed', { item: { type: 'agentMessage', id: 'answer-1', text: 'Working on it.', phase: 'commentary' } }),
    event('item/completed', { item: { type: 'commandExecution', id: 'shell-1', command: 'echo snow', cwd: '/tmp', status: 'completed', aggregatedOutput: 'snow\n' } }),
    event('item/completed', { item: { type: 'fileChange', id: 'patch-1', status: 'completed', changes: [{ path: '/tmp/file', kind: 'update', diff: '+line' }] } }),
    { method: 'item/agentMessage/delta', params: { threadId: 'foreign', turnId: 'turn-1', itemId: 'answer-2', delta: 'NOT OUR THREAD' } },
    event('item/agentMessage/delta', { itemId: 'answer-2', delta: 'FINAL' }),
    event('item/completed', { item: { type: 'agentMessage', id: 'answer-2', text: 'FINAL', phase: 'final_answer' } }));
  snapshot = await h.read();
  assert.equal(snapshot.entries.filter(e => e.kind === 'assistant').length, 2);
  assert.equal(snapshot.entries.find(e => e.id.endsWith('answer-1')).text, 'Working on it.');
  assert.equal(snapshot.entries.find(e => e.id.endsWith('answer-2')).text, 'FINAL');
  assert.equal(snapshot.entries.filter(e => e.kind === 'tool').length, 2);
  assert.equal(snapshot.entries.find(e => e.id.endsWith('shell-1')).text, 'snow\n');
  assert.equal(snapshot.entries.find(e => e.id.endsWith('shell-1')).status, 'done');
  assert.ok(!snapshot.entries.some(e => e.text.includes('NOT OUR THREAD')));
  const earlyViewer = new TranscriptReader('codex');
  let opened; do { opened = await earlyViewer.read([h.file]); } while (opened.loading);
  assert.equal(opened.entries.find(e => e.kind === 'user')?.text, 'Read 雪\u2028now', 'a viewer opened before thread identity is persisted learns it from the native response');
});

test('Codex usage overwrites cumulative snapshots instead of summing twice across runs', async t => {
  const h = fixture(t), { event } = h;
  h.append(event('thread/tokenUsage/updated', { tokenUsage: { last: usage(100, 60, 5), total: usage(100, 60, 5), modelContextWindow: 2000 } }),
    event('thread/tokenUsage/updated', { tokenUsage: { last: usage(50, 10, 7), total: usage(150, 70, 12), modelContextWindow: 2000 } }));
  let s = await h.read();
  assert.equal(s.usage.input, 80); assert.equal(s.usage.cacheRead, 70); assert.equal(s.usage.output, 12);
  const next = path.join(h.dir, 'run-2.jsonl');
  fs.writeFileSync(next, JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 'turn-2',
    tokenUsage: { last: usage(30, 10, 4), total: usage(180, 80, 16), modelContextWindow: 2000 } } }) + '\n');
  s = await h.read([h.file, next]);
  assert.equal(s.usage.input, 100); assert.equal(s.usage.cacheRead, 80); assert.equal(s.usage.output, 16);
  assert.equal(s.entries.filter(e => e.title.startsWith('Run')).length, 2);
  assert.equal((await h.read([])).usage, undefined);
});

test('Codex transcript retains bounded behavior for malformed and oversized records', async t => {
  const h = fixture(t);
  fs.appendFileSync(h.file, 'broken JSON\n');
  for (let n = 0; n < 350; n++) h.append(h.event('item/completed', { item: { type: 'userMessage', id: `u-${n}`, content: [{ type: 'text', text: `Task ${n}` }] } }));
  const s = await h.read();
  assert.ok(s.entries.length <= 300); assert.match(s.notice, /malformed|older/i);
  assert.ok(s.entries.some(e => e.text === 'Task 349'));
});
