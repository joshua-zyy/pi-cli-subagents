import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TranscriptWindow } from '../dist/ui/transcript-window.js';
import { ConversationViewer } from '../dist/ui/conversation.js';

const up = '\x1b[A', down = '\x1b[B', pageUp = '\x1b[5~', home = '\x1b[H', end = '\x1b[F';
const entries = (prefix, count) => Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, kind: 'assistant', title: 'Assistant', text: `${prefix}_${i}` }));
const snapshot = (items, revision = 1, atEnd = false, atStart = false) => ({
  agent: { id: 'a', role: 'worker', phase: 'running', runId: 'r' }, entries: items, revision, outputRevision: 1, loading: false,
  window: { from: { source: 's', offset: 100 }, to: { source: 's', offset: 1000 }, atStart, atEnd, entries: items.length },
});
const tick = () => new Promise(setImmediate);
async function harness(t, initial) {
  const calls = [], pending = [], frames = [];
  const request = kind => { calls.push(kind); return new Promise(resolve => pending.push({ kind, resolve })); };
  let state = initial;
  const tui = { terminal: { rows: 14, columns: 100 }, requestRender() { frames.push(viewer.render(100).join('\n')); } };
  const viewer = new ConversationViewer(tui, { fg: (_, text) => text, bold: text => text }, () => {}, async () => state,
    { intervalMs: 100000, paging: { older: () => request('older'), newer: () => request('newer'), latest: () => request('latest') } });
  t.after(() => viewer.dispose()); await tick();
  return { viewer, calls, frames, text: () => viewer.render(100).join('\n'), async resolve(next) { state = next; pending.shift().resolve(next); await tick(); } };
}

test('ArrowUp and PgUp never request newer pages from a historical window bottom', async t => {
  for (const key of [up, pageUp]) {
    const h = await harness(t, snapshot(entries('OLD', 40)));
    h.viewer.handleInput(key);
    assert.deepEqual(h.calls, [], 'upward intent must not prefetch the newer edge');
    assert.match(h.text(), /Paused/);
  }
});

test('up at the oldest short page does not turn into a newer-page request', async t => {
  const h = await harness(t, snapshot(entries('OLDEST', 2), 1, false, true));
  h.viewer.handleInput(up); h.viewer.handleInput(pageUp); h.viewer.handleInput('unhandled');
  assert.deepEqual(h.calls, []);
});

test('upward prefetch starts two screens before the edge, without moving the visible text', async t => {
  const h = await harness(t, snapshot(entries('MSG', 40), 1, true));
  for (let i = 0; i < 10; i++) h.viewer.handleInput(pageUp); // 74 -> 14 rows from top.
  h.viewer.handleInput(up); // 13
  assert.deepEqual(h.calls, []);
  h.viewer.handleInput(up); // 12 = two six-row screens.
  assert.deepEqual(h.calls, ['older']);
  const visible = h.text().match(/MSG_\d+/g);
  await h.resolve(snapshot([...entries('HISTORY', 25), ...entries('MSG', 40)], 2, false, true));
  assert.deepEqual(h.text().match(/MSG_\d+/g), visible);
  assert.match(h.text(), /Paused/);
});

test('rapid PgUp at a loading boundary is applied after older content arrives', async t => {
  const h = await harness(t, snapshot(entries('MSG', 60), 1, true));
  h.viewer.handleInput(home);
  h.viewer.handleInput(pageUp); h.viewer.handleInput(pageUp);
  assert.deepEqual(h.calls, ['older'], 'same-direction requests are coalesced');
  await h.resolve(snapshot([...entries('HISTORY', 25), ...entries('MSG', 60)], 2, false, true));
  assert.match(h.viewer.render(100)[3], /HISTORY_19/, 'two unconsumed pages must move twelve rows above the old anchor');
  assert.match(h.text(), /Paused/);
  assert.deepEqual(h.calls, ['older']);
});

test('End supersedes an older result without briefly displaying the stale page', async t => {
  const h = await harness(t, snapshot(entries('MSG', 60)));
  h.viewer.handleInput(home); h.viewer.handleInput(pageUp); h.viewer.handleInput(end);
  const start = h.frames.length;
  await h.resolve(snapshot(entries('STALE_HISTORY', 25), 2));
  assert.deepEqual(h.calls, ['older', 'latest']);
  assert.ok(h.frames.slice(start).every(frame => !frame.includes('STALE_HISTORY')));
  await h.resolve(snapshot(entries('LIVE', 1), 3, true));
  assert.match(h.text(), /LIVE_0/); assert.match(h.text(), /Following/);
});

test('changing direction cancels unconsumed upward movement', async t => {
  const h = await harness(t, snapshot(entries('MSG', 60), 1, true));
  h.viewer.handleInput(home); h.viewer.handleInput(pageUp);
  h.viewer.handleInput(down); h.viewer.handleInput(down); // Land on a message, not its separator.
  const visible = h.text().match(/MSG_\d+/g);
  await h.resolve(snapshot([...entries('HISTORY', 25), ...entries('MSG', 60)], 2, false, true));
  assert.deepEqual(h.text().match(/MSG_\d+/g), visible);
});

test('remaining explicit PgUp movement carries into another page without scanning further', async t => {
  const h = await harness(t, snapshot(entries('MSG', 40), 1, true));
  h.viewer.handleInput(home);
  for (let i = 0; i < 5; i++) h.viewer.handleInput(pageUp); // Thirty rows requested past the edge.
  await h.resolve(snapshot([...entries('HISTORY', 10), ...entries('MSG', 40)], 2));
  assert.deepEqual(h.calls, ['older', 'older']);
  await h.resolve(snapshot([...entries('EARLIER', 10), ...entries('HISTORY', 10), ...entries('MSG', 40)], 3, false, true));
  assert.match(h.viewer.render(100)[3], /EARLIER_5/);
  assert.deepEqual(h.calls, ['older', 'older']);
});

test('End supersedes prefetch even while the displayed window still says atEnd', async t => {
  const h = await harness(t, snapshot(entries('MSG', 40), 1, true));
  h.viewer.handleInput(home); h.viewer.handleInput(end);
  await h.resolve(snapshot(entries('HISTORY', 25), 2));
  assert.deepEqual(h.calls, ['older', 'latest']);
  await h.resolve(snapshot(entries('LIVE', 1), 3, true));
  assert.match(h.text(), /LIVE_0/); assert.match(h.text(), /Following/);
});

test('rapid PgUp through a real bounded window preserves all requested movement', async t => {
  const root = path.resolve('.test-output'); await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'rapid-paging-')), file = path.join(dir, 'events.jsonl');
  await fs.writeFile(file, Array.from({ length: 2000 }, (_, i) => JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: `ROW_${i}` } }) + '\n').join(''));
  const window = new TranscriptWindow();
  const agent = snapshot([]).agent;
  let release, calls = 0, firstFrame = false;
  const gate = new Promise(resolve => { release = resolve; });
  const viewer = new ConversationViewer({ terminal: { rows: 14, columns: 100 }, requestRender() { viewer.render(100); firstFrame = true; } },
    { fg: (_, text) => text, bold: text => text }, () => {}, async () => ({ agent, ...await window.open([file]) }),
    { intervalMs: 100000, paging: {
      older: async () => { calls++; await gate; return { agent, ...await window.pageUp([file]) }; },
      newer: async () => { assert.fail('upward movement must not request newer history'); },
      latest: async () => { assert.fail('upward movement must not jump to live output'); },
    } });
  t.after(async () => { viewer.dispose(); window.dispose(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 30 }); });
  for (let i = 0; !firstFrame && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(firstFrame);
  assert.match(viewer.render(100)[3], /ROW_1997\b/);
  for (let i = 0; i < 100; i++) viewer.handleInput(pageUp);
  assert.equal(calls, 1);
  release();
  for (let i = 0; !viewer.render(100)[3].includes('ROW_1697') && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.match(viewer.render(100)[3], /ROW_1697\b/, '100 six-row page presses must move exactly 300 two-row messages');
  assert.match(viewer.render(100).join('\n'), /Paused/);
  assert.equal(calls, 1);
});

test('a page with no added scroll room does not start an automatic history scan', async t => {
  const initial = snapshot(entries('MSG', 40), 1, true);
  const h = await harness(t, initial);
  h.viewer.handleInput(home); h.viewer.handleInput(pageUp);
  await h.resolve({ ...initial, revision: 2 });
  await tick();
  assert.deepEqual(h.calls, ['older']);
});
