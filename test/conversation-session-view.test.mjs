import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationViewer } from '../dist/ui/conversation.js';
import { TranscriptWindow } from '../dist/ui/transcript-window.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const tick = () => new Promise(resolve => setTimeout(resolve, 10));
const entry = i => ({ id: `m${i}`, kind: 'assistant', title: 'Assistant', text: `MESSAGE_${i}`, span: { start: { source: 'log', offset: i * 10 }, end: { source: 'log', offset: (i + 1) * 10 } } });
const snapshot = (from, to, revision, atEnd = false) => ({ agent: { id: 'a', role: 'worker', phase: 'completed', runId: 'r' }, entries: Array.from({ length: to - from }, (_, i) => entry(from + i)), loading: false, revision, model: `revision-${revision}`, window: { from: { source: 'log', offset: from * 10 }, to: { source: 'log', offset: to * 10 }, atStart: from === 0, atEnd, entries: to - from } });
async function harness(t, initial, deferredPaint = false) {
  let current = initial, resolveOlder;
  const calls = [], frames = [];
  const viewer = new ConversationViewer({ terminal: { rows: 14, columns: 100 }, requestRender() { if (!deferredPaint) frames.push(viewer.render(100)); } }, { fg: (_, s) => s, bold: s => s }, () => {}, async () => current, {
    intervalMs: 15, paging: {
      older: boundary => { calls.push({ kind: 'older', boundary }); return new Promise(resolve => { resolveOlder = resolve; }); },
      newer: async boundary => { calls.push({ kind: 'newer', boundary }); return current; },
      latest: async () => { calls.push({ kind: 'latest' }); return initial; },
    },
  });
  t.after(() => viewer.dispose()); await tick(); viewer.render(100);
  return { viewer, calls, frames, text: () => viewer.render(100).join('\n'), set(next) { current = next; }, async resolve(next) { current = next; resolveOlder(next); await tick(); } };
}

test('an older disk window with no shared ids cannot replace the content being read', async t => {
  const h = await harness(t, snapshot(40, 80, 1, true));
  h.viewer.handleInput('\x1b[H');
  const before = h.text().match(/MESSAGE_\d+/g);
  await h.resolve(snapshot(0, 40, 2));
  assert.deepEqual(h.text().match(/MESSAGE_\d+/g), before);
  assert.match(h.text(), /Paused/);
  h.viewer.handleInput('\x1b[H');
  assert.match(h.text(), /MESSAGE_0\b/);
  assert.equal(h.calls.length, 1, 'the display knows the loaded history reaches the beginning');
});

test('a live disk window cannot evict the message in a paused display', async t => {
  const h = await harness(t, snapshot(0, 60, 1, true));
  h.viewer.handleInput('\x1b[H');
  h.set(snapshot(40, 100, 2, true));
  for (let i = 0; !h.text().includes('revision-2') && i < 100; i++) await tick();
  assert.match(h.text(), /revision-2/);
  assert.match(h.text(), /MESSAGE_0\b/);
  assert.match(h.text(), /Paused/);
});

test('scroll keys measure current content even when the host has not painted a prepended page', async t => {
  const h = await harness(t, snapshot(40, 80, 1, true), true);
  h.viewer.handleInput('\x1b[H');
  await h.resolve(snapshot(0, 80, 2, true));
  // No render between accepting the page and the next two key presses.
  h.viewer.handleInput('\x1b[B'); h.viewer.handleInput('\x1b[B');
  assert.match(h.viewer.render(100)[3], /MESSAGE_41\b/, 'Down must never jump upwards against a stale maxScroll');
});

test('removing a completed head marker preserves a position inside the message body', async t => {
  const first = snapshot(40, 80, 1, true);
  const body = Array.from({ length: 20 }, (_, i) => `LINE_${i}`).join('\n');
  first.entries[0] = { ...entry(40), text: body, partial: 'head' };
  const h = await harness(t, first);
  h.viewer.handleInput('\x1b[H');
  h.viewer.handleInput('\x1b[B'); h.viewer.handleInput('\x1b[B');
  assert.match(h.viewer.render(100)[3], /LINE_1\b/);
  const next = snapshot(0, 80, 2, true);
  next.entries[40] = { ...entry(40), id: 'completed', text: body, span: { start: { source: 'log', offset: 395 }, end: { source: 'log', offset: 410 } } };
  await h.resolve(next);
  assert.match(h.viewer.render(100)[3], /LINE_1\b/);
});

test('real disk paging and coalesced paints keep 500 rapid PgUp presses monotonic across display eviction', async t => {
  const root = path.resolve('.test-output'); await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'session-view-')), file = path.join(dir, 'events.jsonl');
  const original = Array.from({ length: 1500 }, (_, i) => JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: `MESSAGE_${i}` } }) + '\n').join('');
  await fs.writeFile(file, original);
  const window = new TranscriptWindow(), positions = [];
  let paint, pageCalls = 0, latestCalls = 0;
  const agent = snapshot(0, 0, 0).agent;
  const viewer = new ConversationViewer({ terminal: { rows: 14, columns: 100 }, requestRender() {
    if (!paint) paint = setTimeout(() => { paint = undefined; const frame = viewer.render(100); const match = frame.slice(3, 9).join('\n').match(/MESSAGE_(\d+)/); if (match) positions.push(Number(match[1])); }, 16);
  } }, { fg: (_, s) => s, bold: s => s }, () => {}, async () => ({ agent, ...await window.open([file]) }), { intervalMs: 20, paging: {
    older: async boundary => { pageCalls++; return { agent, ...await window.pageUp([file], boundary) }; },
    newer: async () => { assert.fail('upward input cannot request newer history'); },
    latest: async () => { latestCalls++; return { agent, ...await window.toTail([file]) }; },
  } });
  t.after(async () => { viewer.dispose(); window.dispose(); if (paint) clearTimeout(paint); await fs.rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 30 }); });
  for (let i = 0; !positions.length && i < 200; i++) await tick();
  assert.equal(positions[0], 1497);
  for (let i = 0; i < 500; i++) { viewer.handleInput('\x1b[5~'); await new Promise(setImmediate); }
  for (let i = 0; positions.at(-1) !== 0 && i < 200; i++) await tick();
  assert.equal(positions.at(-1), 0);
  assert.ok(positions.every((value, i) => i === 0 || value <= positions[i - 1]), `visible message positions moved forward: ${positions}`);
  assert.match(viewer.render(100).join('\n'), /Paused/);
  assert.ok(pageCalls >= 4 && pageCalls < 12);
  viewer.handleInput('\x1b[F');
  for (let i = 0; !viewer.render(100).join('\n').includes('MESSAGE_1499') && i < 200; i++) await tick();
  assert.match(viewer.render(100).join('\n'), /MESSAGE_1499/);
  assert.equal(latestCalls, 1);
  assert.equal(await fs.readFile(file, 'utf8'), original, 'viewing never modifies the source log');
});

test('paging is requested against the displayed edge, not an unrelated disk cursor', async t => {
  const h = await harness(t, snapshot(40, 80, 1, true));
  h.viewer.handleInput('\x1b[H');
  assert.deepEqual(h.calls[0], { kind: 'older', boundary: { position: { source: 'log', offset: 400 }, id: 'm40' } });
});
