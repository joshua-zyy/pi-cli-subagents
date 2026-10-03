// On-demand history window: bounded tail first, paging only when the reader asks for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { TranscriptWindow } from '../dist/ui/transcript-window.js';
import { logSourceKey } from '../dist/ui/transcript.js';

const root = path.resolve('.test-output'); fs.mkdirSync(root, { recursive: true });
const CHUNK = 512 * 1024;
const LOOKBACK = 4 * 1024 * 1024 + CHUNK;   // documented boundary lookback cap

const record = (text, input = 1) => ({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }],
  provider: 'fixture', model: 'fixture-model', usage: { input, output: 1, totalTokens: input + 1 } } });
const started = () => ({ type: 'message_start', message: { role: 'assistant', content: [] } });
const delta = text => ({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text } });
const ignored = (bytes, tag = 'PAD') => ({ type: 'ignored', padding: tag + 'x'.repeat(Math.max(0, bytes - tag.length)) });
const toolStart = (id, name, args) => ({ type: 'tool_execution_start', toolCallId: id, toolName: name, args });
const toolEnd = (id, name, text, isError = false) => ({ type: 'tool_execution_end', toolCallId: id, toolName: name, isError, result: { content: [{ type: 'text', text }] } });
const line = value => JSON.stringify(value) + '\n';
const append = (file, ...records) => fs.appendFileSync(file, records.map(line).join(''));
const has = (snapshot, text) => snapshot.entries.some(entry => entry.text.includes(text));
const find = (snapshot, text) => snapshot.entries.find(entry => entry.text.includes(text));

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(root, 'window-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 30 }));
  const files = [];
  const run = () => {
    const folder = path.join(dir, `run-${files.length + 1}`); fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'events.jsonl'); fs.writeFileSync(file, ''); files.push(file); return file;
  };
  return { dir, run, files: () => [...files] };
}
/** A long run whose records are big enough that the tail window must page to reach the start. */
function longRun(file, count, payload = 1200) {
  const rows = [];
  for (let i = 0; i < count; i++) rows.push(record(`ITEM_${String(i).padStart(3, '0')} ` + 'x'.repeat(payload), i + 1));
  append(file, ...rows);
}

test('the first frame reads a bounded tail and hides incomplete whole-log totals', async t => {
  const w = workspace(t);
  const old = w.run();
  append(old, record('OLD_MESSAGE'), ...Array.from({ length: 240 }, (_, i) => ignored(16 * 1024, `OLD_PAD_${i}_`)));
  const live = w.run(); append(live, record('LIVE_TAIL', 7));
  const window = new TranscriptWindow(); t.after(() => window.dispose());
  const first = await window.open(w.files());
  assert.equal(first.usageComplete, false, 'a tail window cannot claim whole-log totals');
  assert.equal(first.usage, undefined, 'incomplete totals are hidden, never fabricated');
  assert.ok(has(first, 'LIVE_TAIL')); assert.ok(!has(first, 'OLD_MESSAGE'));
  assert.equal(first.window.atEnd, true); assert.equal(first.window.atStart, false);
  assert.equal(first.window.from.source, logSourceKey(old), 'the window start names the run it came from');
  assert.ok(first.window.from.offset >= 2 * 1024 * 1024, `the start sits in the older padding: ${first.window.from.offset}`);
  const stats = window.stats();
  assert.ok(stats.readBytes <= CHUNK + LOOKBACK, `bounded first read: ${stats.readBytes}`);
  assert.ok(stats.readBytes < 3 * 1024 * 1024, 'the old run was never read in full');
});

test('refreshing without appends performs no I/O and never walks older history', async t => {
  const w = workspace(t);
  const file = w.run();
  append(file, record('OLD_TAIL'), ignored(1024 * 1024, 'PAD'), record('TAIL_ONE', 2));
  const window = new TranscriptWindow(); t.after(() => window.dispose());
  const first = await window.open([file]);
  assert.ok(!has(first, 'OLD_TAIL'), 'the initial frame is a bounded tail');
  const before = window.stats();
  for (let i = 0; i < 12; i++) await window.open([file]);
  const idle = window.stats();
  assert.equal(idle.readBytes, before.readBytes, 'no reads while nothing changed');
  assert.equal(idle.readCalls, before.readCalls);
  assert.deepEqual(idle.from, before.from, 'the window start never moves unprompted');
  assert.equal(idle.to.offset, before.to.offset);
  append(file, record('APPENDED', 3));
  const next = await window.open([file]);
  assert.ok(has(next, 'APPENDED'));
  const grown = window.stats();
  assert.ok(grown.readBytes > idle.readBytes, 'an append is read');
  assert.ok(grown.readBytes - idle.readBytes < 4096, `only the append is read: ${grown.readBytes - idle.readBytes}`);
});

test('page-up adds one bounded step of older records and keeps retained entry ids stable', async t => {
  const w = workspace(t);
  const file = w.run(); longRun(file, 900);
  const window = new TranscriptWindow(); t.after(() => window.dispose());
  const first = await window.open([file]);
  assert.ok(!first.window.atStart); assert.equal(first.window.entries <= 300, true);
  const before = window.stats();
  const retained = new Map(first.entries.map(entry => [entry.id, entry.text]));
  const up = await window.pageUp([file]);
  const step = window.stats();
  assert.ok(step.readBytes - before.readBytes <= CHUNK + LOOKBACK + CHUNK, `bounded page step: ${step.readBytes - before.readBytes}`);
  assert.ok(up.window.from.offset < first.window.from.offset, 'the start strictly moves towards older records');
  assert.equal(up.window.entries <= 300, true);
  const shared = up.entries.filter(entry => retained.has(entry.id));
  assert.ok(shared.length > 0, 'paging keeps the entries that stay in the window');
  for (const entry of shared) assert.equal(entry.text, retained.get(entry.id), 'stable ids keep the same content');
  assert.equal(up.outputRevision, first.outputRevision, 'paging is not new child output');
});

test('repeated page-up reaches the first record even though only 300 entries are visible', async t => {
  const w = workspace(t);
  const file = w.run(); longRun(file, 900);
  const window = new TranscriptWindow(); t.after(() => window.dispose());
  let snapshot = await window.open([file]);
  let steps = 0;
  while (!snapshot.window.atStart && steps < 20) { snapshot = await window.pageUp([file]); steps++; }
  assert.equal(snapshot.window.atStart, true, 'the oldest record is reachable');
  assert.ok(steps >= 2 && steps < 20, `bounded number of steps: ${steps}`);
  assert.ok(has(snapshot, 'ITEM_000'), 'the first record is visible');
  assert.equal(snapshot.window.from.offset, 0);
  assert.equal(snapshot.window.entries <= 300, true);
});

test('page-down restores the entries evicted while paging up and returns to the live end', async t => {
  const w = workspace(t);
  const file = w.run(); longRun(file, 900); append(file, record('LIVE_TAIL', 5));
  const window = new TranscriptWindow(); t.after(() => window.dispose());
  const first = await window.open([file]);
  const evicted = first.entries.filter(entry => /ITEM_8\d\d/.test(entry.text)).map(entry => entry.id);
  assert.ok(evicted.length > 0);
  let snapshot = await window.pageUp([file]);
  assert.ok(!snapshot.entries.some(entry => evicted.includes(entry.id)), 'paging up evicts the newest page');
  let steps = 0;
  while (!snapshot.window.atEnd && steps < 20) { snapshot = await window.pageDown([file]); steps++; }
  assert.equal(snapshot.window.atEnd, true, 'page-down walks back to the live end');
  assert.ok(snapshot.entries.some(entry => evicted.includes(entry.id)), 'evicted entries come back with the same ids');
  assert.ok(has(snapshot, 'LIVE_TAIL'));
  assert.equal(snapshot.outputRevision, first.outputRevision, 'walking back is not new child output');
});

test('appended bytes advance outputRevision while page moves do not', async t => {
  const w = workspace(t);
  const file = w.run(); longRun(file, 700);
  const window = new TranscriptWindow(); t.after(() => window.dispose());
  const first = await window.open([file]);
  const up = await window.pageUp([file]);
  const down = await window.pageDown([file]);
  assert.equal(up.outputRevision, first.outputRevision);
  assert.equal(down.outputRevision, first.outputRevision);
  append(file, record('FRESH_OUTPUT', 9));
  const refreshed = await window.open([file]);
  assert.ok(has(refreshed, 'FRESH_OUTPUT'));
  assert.ok(refreshed.outputRevision > first.outputRevision, 'live bytes are the only new-output signal');
});

test('a stream split by the window start is replayed from its own record group', async t => {
  const w = workspace(t);
  const file = w.run();
  append(file, ...Array.from({ length: 200 }, (_, i) => record(`FILLER_${i} ` + 'f'.repeat(2000))));
  append(file, started(), ...Array.from({ length: 120 }, (_, i) => delta(`DELTA_${String(i).padStart(3, '0')} ` + 'd'.repeat(120))));
  const window = new TranscriptWindow(); t.after(() => window.dispose());
  const first = await window.open([file]);
  const stream = find(first, 'DELTA_');
  assert.ok(stream, 'the streaming message is visible');
  // A still-open stream is marked as continuing below; its head must never be cut by the window start.
  assert.notEqual(stream.partial, 'head', 'the window start lands on a boundary before the message');
  assert.ok(stream.text.startsWith('DELTA_000'), 'the replay begins at the first delta');
  assert.ok(stream.text.includes('DELTA_119'));
  // A group longer than the lookback cap cannot be replayed whole; it is marked, never invented.
  const far = w.run();
  append(far, started(), ...Array.from({ length: 2400 }, (_, i) => delta(`FAR_${String(i).padStart(4, '0')} ` + 'd'.repeat(2000))));
  const other = new TranscriptWindow(); t.after(() => other.dispose());
  const tail = await other.open([far]);
  const partial = find(tail, 'FAR_');
  assert.ok(partial, 'the far stream tail is visible');
  assert.equal(partial.partial, 'head', 'a group beyond the lookback is marked as continuing above');
  assert.equal(tail.window.from.offset > 0, true);
});

test('parallel tools spanning a page keep their native ids and final output', async t => {
  const w = workspace(t);
  const file = w.run();
  append(file, toolStart('call-A', 'bash', { command: 'first' }), toolStart('call-B', 'bash', { command: 'second' }),
    { type: 'tool_execution_update', toolCallId: 'call-A', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'A_PARTIAL' }] } },
    { type: 'tool_execution_update', toolCallId: 'call-B', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'B_PARTIAL' }] } },
    toolEnd('call-B', 'bash', 'B_FINAL'), toolEnd('call-A', 'bash', 'A_FINAL'),
    ignored(700 * 1024, 'GAP'), record('TAIL', 4));
  const window = new TranscriptWindow(); t.after(() => window.dispose());
  let snapshot = await window.open([file]);
  let steps = 0;
  while (!snapshot.entries.some(entry => entry.kind === 'tool') && steps < 10) { snapshot = await window.pageUp([file]); steps++; }
  const tools = snapshot.entries.filter(entry => entry.kind === 'tool');
  assert.equal(tools.length, 2);
  const a = tools.find(entry => entry.id.includes('call-A')), b = tools.find(entry => entry.id.includes('call-B'));
  assert.ok(a && b, 'native call ids stay in the entry identity');
  assert.equal(a.text, 'A_FINAL', 'the final output wins over the earlier partial');
  assert.equal(b.text, 'B_FINAL');
  assert.equal(a.status, 'done'); assert.equal(b.status, 'done');
});

test('records split by UTF-8, LF framing and oversized prefixes stay lossless', async t => {
  const w = workspace(t);
  const file = w.run();
  append(file, record('BEFORE_SPLIT', 2));
  const bytes = Buffer.from(line(record('雪花 AFTER_SPLIT', 3)));
  const split = bytes.indexOf(Buffer.from('雪')) + 1;
  fs.appendFileSync(file, bytes.subarray(0, split));
  const window = new TranscriptWindow(); t.after(() => window.dispose());
  const early = await window.open([file]);
  assert.ok(has(early, 'BEFORE_SPLIT'));
  assert.ok(!has(early, 'AFTER_SPLIT'), 'an unfinished record is not decoded');
  fs.appendFileSync(file, bytes.subarray(split));
  const done = await window.open([file]);
  assert.ok(has(done, '雪花 AFTER_SPLIT'));
  assert.equal(done.entries.filter(entry => entry.text === '雪花 AFTER_SPLIT').length, 1);
  assert.ok(!done.entries.some(entry => entry.text.includes('\uFFFD')));
  // An oversized record must not swallow the next valid one, and its loss is reported.
  const big = w.run();
  fs.writeFileSync(big, line(ignored(5 * 1024 * 1024, 'HUGE_')) + line(record('VALID_AFTER_OVERSIZE', 4)) + line(record('TAIL_AFTER_OVERSIZE', 5)));
  const other = new TranscriptWindow(); t.after(() => other.dispose());
  const snapshot = await other.open([big]);
  assert.ok(has(snapshot, 'VALID_AFTER_OVERSIZE'));
  assert.ok(has(snapshot, 'TAIL_AFTER_OVERSIZE'));
  assert.equal(snapshot.usageComplete, false);
});

test('empty, absent and late runs keep the window readable and catch up afterwards', async t => {
  for (const absent of [false, true]) {
    const w = workspace(t);
    const old = w.run(); append(old, record('PREVIOUS_RUN', 11));
    const live = w.run(); if (!absent) fs.writeFileSync(live, '');
    const window = new TranscriptWindow(); t.after(() => window.dispose());
    const first = await window.open(w.files());
    assert.ok(has(first, 'PREVIOUS_RUN'), 'an empty or missing latest run falls back to readable content');
    assert.equal(first.window.atEnd, true);
    assert.equal(first.usageComplete, true, 'the whole readable log is covered');
    assert.equal(first.usage.input, 11);
    append(live, record('NEW_RUN_AVAILABLE', 4));
    const next = await window.open(w.files());
    assert.ok(has(next, 'NEW_RUN_AVAILABLE'));
    assert.equal(next.window.to.source, logSourceKey(live));
    assert.equal(next.usage.input, 15);
  }
});

test('an unknown native identity claims nothing from the tail until the run head says otherwise', async t => {
  const w = workspace(t);
  const file = w.run();
  const message = (id, text) => ({ type: 'assistant', session_id: id, message: { id: text, content: [{ type: 'text', text }] } });
  fs.writeFileSync(file, line({ type: 'system', subtype: 'init', session_id: 'own', model: 'fixture' })
    + line(ignored(600 * 1024, 'GAP_')) + line(message('foreign', 'FOREIGN_OUTPUT')) + line(message('own', 'OWN_OUTPUT')));
  const window = new TranscriptWindow('claude'); t.after(() => window.dispose());
  const snapshot = await window.open([file]);
  assert.ok(has(snapshot, 'OWN_OUTPUT'));
  assert.ok(!has(snapshot, 'FOREIGN_OUTPUT'));
  const stranger = w.run();
  fs.writeFileSync(stranger, line(ignored(600 * 1024, 'GAP_')) + line(message('foreign', 'UNTRUSTED_TAIL')));
  const unknown = new TranscriptWindow('claude'); t.after(() => unknown.dispose());
  const claimed = await unknown.open([stranger]);
  assert.ok(!has(claimed, 'UNTRUSTED_TAIL'), 'a tail record cannot establish an unknown identity');
  assert.match(claimed.notice ?? '', /identity/i);
});

test('truncation, rewrite and same-size replacement reset the window instead of reviving stale text', async t => {
  const w = workspace(t);
  const file = w.run();
  append(file, record('ORIGINAL_TEXT'), ignored(2048, 'TAIL_'));
  const window = new TranscriptWindow(); t.after(() => window.dispose());
  const first = await window.open([file]);
  assert.ok(has(first, 'ORIGINAL_TEXT'));
  fs.writeFileSync(file, line(record('TRUNCATED_FRESH', 3)));
  const shrunk = await window.open([file]);
  assert.ok(has(shrunk, 'TRUNCATED_FRESH')); assert.ok(!has(shrunk, 'ORIGINAL_TEXT'));
  assert.equal(shrunk.usage.input, 3);
  // Same size, different bytes: mtime/ctime move, so the whole file is invalid.
  const same = w.run();
  const size = 4096;
  fs.writeFileSync(same, line(record('REWRITE_A ' + 'a'.repeat(size))));
  const other = new TranscriptWindow(); t.after(() => other.dispose());
  assert.ok(has(await other.open([same]), 'REWRITE_A'));
  const bytes = fs.statSync(same).size;
  fs.writeFileSync(same, line(record('REWRITE_B ' + 'b'.repeat(size))));
  assert.equal(fs.statSync(same).size, bytes, 'the rewrite keeps the file size');
  const future = new Date(Date.now() + 4000);
  fs.utimesSync(same, future, future);
  const rewritten = await other.open([same]);
  assert.ok(has(rewritten, 'REWRITE_B')); assert.ok(!has(rewritten, 'REWRITE_A'));
});

test('dispose stops further reads and a later open re-attaches instead of reusing dropped state', async t => {
  const w = workspace(t);
  const file = w.run(); longRun(file, 400, 1200);
  const window = new TranscriptWindow();
  const first = await window.open([file]);
  assert.ok(first.entries.length > 0, 'the window is readable before disposal');
  const before = window.stats();
  await window.pageUp([file]);
  window.dispose();
  assert.ok(window.stats().readBytes >= before.readBytes);
  const again = await window.open([file]);
  assert.ok(again.window.atEnd, 'a disposed window re-attaches at the live tail');
  assert.equal(again.window.from.source, logSourceKey(file));
});

test('a live append larger than one page keeps catching up and never re-reads a partial tail', async t => {
  const w = workspace(t);
  const file = w.run(); append(file, record('FIRST'));
  const window = new TranscriptWindow(); t.after(() => window.dispose());
  await window.open([file]);
  append(file, record('LARGE_' + 'x'.repeat(700 * 1024), 3));
  let snapshot = await window.open([file]);
  assert.equal(snapshot.loading, true, 'a page-bounded read keeps asking for more');
  assert.equal(snapshot.window.atEnd, false, 'not caught up yet, but still following the live end');
  const midway = window.stats().readBytes;
  snapshot = await window.open([file]);
  assert.equal(snapshot.loading, false);
  assert.equal(snapshot.window.atEnd, true, 'catching up restores the live-end state');
  assert.equal(snapshot.entries.filter(entry => entry.text.startsWith('LARGE_')).length, 1, 'the append is published once');
  assert.ok(window.stats().readBytes > midway, 'every follow-up open makes progress');
  const settled = window.stats().readBytes;
  await window.open([file]); await window.open([file]);
  assert.equal(window.stats().readBytes, settled, 'a caught-up window reads nothing new');
  // An unchanged partial trailing record stays buffered instead of being read again on every refresh.
  const partial = line(record('PARTIAL_TAIL'));
  fs.appendFileSync(file, partial.slice(0, partial.length - 8));
  await window.open([file]);
  const buffered = window.stats().readBytes;
  await window.open([file]); await window.open([file]);
  assert.equal(window.stats().readBytes, buffered, 'an unchanged partial tail is never re-read');
  fs.appendFileSync(file, partial.slice(partial.length - 8));
  for (let i = 0; i < 3 && !snapshot.entries.some(entry => entry.text === 'PARTIAL_TAIL'); i++) snapshot = await window.open([file]);
  assert.equal(snapshot.entries.filter(entry => entry.text === 'PARTIAL_TAIL').length, 1, 'the completed record is published exactly once');
});

test('a cancel after consumed bytes keeps the real cursor, so the next open neither rewinds nor duplicates', async t => {
  const w = workspace(t);
  const file = w.run();
  append(file, record('FIRST'));
  // A page budget that lands inside a record leaves the parser's raw cursor ahead of the published end.
  const window = new TranscriptWindow('pi', undefined, { pageBytes: 4096, initialBytes: 4096 });
  t.after(() => window.dispose());
  await window.open([file]);
  append(file, ...Array.from({ length: 24 }, (_, i) => record(`MID_${i} ` + 'm'.repeat(900))));
  const originalOpen = fsPromises.open;
  const reads = [];
  let releaseGate, enteredGate, gateNext = false, gated = false;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  const entered = new Promise(resolve => { enteredGate = resolve; });
  fsPromises.open = async (...args) => {
    const handle = await originalOpen(...args);
    const read = handle.read.bind(handle);
    handle.read = async (...input) => {
      const length = Number(input[2] ?? 0);
      reads.push({ position: Number(input[3] ?? 0), length });
      // Only parser page reads are held: a refresh first reads 64 bytes to validate the tail sample.
      if (gateNext && !gated && length > 256) { gated = true; enteredGate(); await gate; }
      return read(...input);
    };
    return handle;
  };
  syncBuiltinESMExports();
  t.after(() => { fsPromises.open = originalOpen; syncBuiltinESMExports(); });
  const first = await window.open([file]);
  assert.equal(first.loading, true, 'one bounded page leaves the rest of the append to read');
  gateNext = true;
  const pending = window.open([file]);
  await entered;
  const resume = reads[reads.length - 1].position;
  assert.ok(resume >= 4096, 'the parser has already consumed a full page');
  window.cancel();
  releaseGate();
  await pending;
  const reopenFrom = reads.length;
  let snapshot = await window.open([file]);
  for (let i = 0; i < 20 && snapshot.loading; i++) snapshot = await window.open([file]);
  assert.equal(snapshot.loading, false, 'the reopened window catches up');
  const parserReads = reads.slice(reopenFrom).filter(read => read.length > 256);
  assert.ok(parserReads.length > 0, 'the reopen keeps reading content');
  assert.ok(parserReads.every(read => read.position >= resume), 'reopening resumes at the parser cursor instead of rewinding into consumed bytes');
  const mids = snapshot.entries.filter(entry => entry.text.startsWith('MID_'));
  assert.equal(mids.length, 24, 'no record is replayed or duplicated after the cancelled page');
  assert.equal(new Set(mids.map(entry => entry.id)).size, 24, 'entry identities stay unique');
});
