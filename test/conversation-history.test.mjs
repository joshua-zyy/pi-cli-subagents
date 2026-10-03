import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationHistory } from '../dist/ui/conversation-history.js';
const position = offset => ({ source: 'log', offset });
const entry = i => ({ id: `m${i}`, kind: 'assistant', title: 'Assistant', text: `MESSAGE_${i}`, span: { start: position(i * 10), end: position((i + 1) * 10) } });
const snapshot = (from, to, revision, atEnd = false) => ({ entries: Array.from({ length: to - from }, (_, i) => entry(from + i)), loading: false, revision, sourceEpoch: 1, window: { from: position(from * 10), to: position(to * 10), atStart: from === 0, atEnd, entries: to - from } });
const none = new Set();

test('display bounds survive an older reader cursor and repeated polls', () => {
  const history = new ConversationHistory();
  history.accept(snapshot(4, 8, 1, true), 'refresh', none);
  const older = snapshot(0, 4, 2);
  history.accept(older, 'older', new Set(['m4']));
  const result = history.accept(older, 'refresh', new Set(['m4']));
  assert.deepEqual(result.entries.map(e => e.id), Array.from({ length: 8 }, (_, i) => `m${i}`));
  assert.equal(result.window.atStart, true); assert.equal(result.window.atEnd, true);
  assert.deepEqual(result.window.to, position(80));
  assert.deepEqual(history.readerWindow.to, position(40));
});

test('frozen visible content updates after leaving it, without requiring another log revision', () => {
  const history = new ConversationHistory();
  const first = snapshot(0, 2, 1, true);
  history.accept(first, 'refresh', none);
  const update = { ...first, revision: 2, entries: [{ ...entry(0), text: 'UPDATED' }, entry(1)] };
  const held = history.accept(update, 'refresh', new Set(['m0']));
  assert.equal(held.entries[0].text, 'MESSAGE_0');
  const released = history.accept(update, 'refresh', none);
  assert.equal(released.entries[0].text, 'UPDATED');
  assert.notEqual(released.revision, held.revision);
  assert.equal(released.outputRevision, held.outputRevision);
});

test('display retention is bounded and does not evict pinned messages', () => {
  const history = new ConversationHistory(4, 1000);
  history.accept(snapshot(2, 6, 1, true), 'refresh', none);
  const held = history.accept(snapshot(0, 2, 2), 'older', new Set(['m3']));
  assert.equal(held.entries.length, 4);
  assert.ok(held.entries.some(e => e.id === 'm3'));
  assert.equal(held.window.atEnd, false);
  const next = history.accept(snapshot(4, 8, 3, true), 'newer', new Set(['m3']));
  assert.equal(next.entries.length, 4);
  assert.ok(next.entries.some(e => e.id === 'm3'));
  assert.equal(next.window.atStart, false);
  const bytes = new ConversationHistory(20, 180);
  const wide = value => ({ ...value, entries: value.entries.map(e => ({ ...e, text: '汉'.repeat(15) })) });
  bytes.accept(wide(snapshot(3, 5, 1)), 'refresh', none);
  const limited = bytes.accept(wide(snapshot(0, 3, 2)), 'older', new Set(['m3']));
  assert.ok(limited.entries.some(e => e.id === 'm3'));
  assert.ok(limited.entries.reduce((n, e) => n + Buffer.byteLength(e.text + (e.input ?? '') + e.title + e.id), 0) <= 180);
});

test('source replacement clears history, and delayed results cannot restore an old source epoch', () => {
  const history = new ConversationHistory();
  const old = snapshot(0, 4, 1, true);
  history.accept(old, 'refresh', none);
  const missing = { entries: [], loading: false, revision: 1, sourceEpoch: 2 };
  history.accept(missing, 'refresh', none);
  assert.deepEqual(history.accept(old, 'refresh', none).entries, []);
  const replacement = { ...snapshot(9, 10, 2, true), sourceEpoch: 2 };
  assert.deepEqual(history.accept(replacement, 'refresh', none).entries.map(e => e.id), ['m9']);
  assert.deepEqual(history.accept(old, 'refresh', none).entries.map(e => e.id), ['m9']);
  const bounded = new ConversationHistory(2);
  bounded.accept(snapshot(2, 4, 1), 'refresh', none);
  const reset = bounded.accept({ ...snapshot(2, 4, 2), sourceEpoch: 2,
    entries: [entry(2), entry(2.5), entry(3)].map(e => ({ ...e, text: 'REPLACED' })) }, 'refresh', new Set(['m2', 'm3']));
  assert.equal(reset.sourceEpoch, 2, 'old visible pins cannot roll back a source replacement under budget pressure');
  assert.ok(reset.entries.every(e => e.text === 'REPLACED'));
});

test('only an identical complete representation supersedes a head fragment; tool calls remain distinct', () => {
  const history = new ConversationHistory();
  const fragment = { ...entry(1), id: 'fragment', partial: 'head', text: 'SAME', span: { start: position(100), end: position(200) } };
  history.accept({ ...snapshot(1, 2, 1), entries: [fragment] }, 'refresh', none);
  const complete = { ...fragment, id: 'complete', partial: undefined, span: { start: position(40), end: position(200) } };
  const full = history.accept({ ...snapshot(0, 2, 2), entries: [complete] }, 'older', new Set(['fragment']));
  assert.deepEqual(full.entries.map(e => e.id), ['complete']);
  const tools = new ConversationHistory();
  const a = { ...fragment, id: 'call-a', kind: 'tool', status: 'done' };
  const b = { ...complete, id: 'call-b', kind: 'tool', status: 'done' };
  tools.accept({ ...snapshot(1, 2, 1), entries: [a] }, 'refresh', none);
  const separate = tools.accept({ ...snapshot(0, 2, 2), entries: [b, { ...a, status: 'running' }] }, 'older', none);
  assert.deepEqual(separate.entries.map(e => e.id), ['call-b', 'call-a']);
  assert.equal(separate.entries[1].status, 'done');
  const different = new ConversationHistory();
  different.accept({ ...snapshot(1, 2, 1), entries: [fragment] }, 'refresh', none);
  const notEqual = different.accept({ ...snapshot(0, 2, 2), entries: [{ ...complete, text: 'DIFFERENT' }] }, 'older', none);
  assert.equal(notEqual.entries.length, 2, 'overlap alone never authorizes a merge');
});
