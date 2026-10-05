import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { TranscriptWindow } from '../dist/ui/transcript-window.js';
import { TranscriptCache } from '../dist/ui/transcript-cache.js';
import { ConversationViewer } from '../dist/ui/conversation.js';
import { waitUntil } from '../dist/storage.js';

const line = value => JSON.stringify(value) + '\n';
const message = text => ({ type: 'message_end', message: { role: 'assistant', content: text } });
const padding = size => ({ type: 'ignored', padding: 'x'.repeat(size) });
const has = (snapshot, text) => snapshot.entries.some(entry => entry.kind === 'assistant' && entry.text === text);
async function fixture(t, options) {
  const root = path.resolve('.test-output');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'window-adversarial-'));
  const window = new TranscriptWindow('pi', undefined, options);
  t.after(async () => { window.dispose(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 30 }); });
  return { dir, window };
}
async function toStart(window, files, snapshot, visit = () => {}) {
  visit(snapshot);
  for (let i = 0; !snapshot.window.atStart && i < 300; i++) {
    snapshot = await window.pageUp(files);
    visit(snapshot);
  }
  assert.equal(snapshot.window.atStart, true, 'earlier history must remain reachable');
  return snapshot;
}

// These checks are independent of parser counters: intercept the actual file handle reads.
function trackReads(t) {
  const original = fs.open, originalReadFile = fs.readFile;
  const reads = [];
  fs.readFile = async (...args) => {
    const result = await originalReadFile(...args);
    reads.push({ file: String(args[0]), bytes: Buffer.byteLength(result), position: 0 });
    return result;
  };
  fs.open = async (...args) => {
    const handle = await original(...args);
    const read = handle.read.bind(handle);
    handle.read = async (...input) => {
      const result = await read(...input);
      reads.push({ file: String(args[0]), bytes: result.bytesRead, position: input[3] ?? input[0]?.position });
      return result;
    };
    return handle;
  };
  syncBuiltinESMExports();
  t.after(() => { fs.open = original; fs.readFile = originalReadFile; syncBuiltinESMExports(); });
  return reads;
}

test('stationary opens do not read historical bytes; append reads only new data plus bounded validation', async t => {
  const { dir, window } = await fixture(t, { initialBytes: 512 * 1024 });
  const file = path.join(dir, 'events.jsonl');
  await fs.writeFile(file, line(message('OLD_HEAD')) + line(padding(64 * 1024)).repeat(192) + line(message('RECENT')));
  const reads = trackReads(t);
  const first = await window.open([file]);
  assert.ok(reads.some(read => read.bytes > 0), 'instrumentation must observe actual content reads');
  assert.ok(has(first, 'RECENT'));
  assert.equal(first.usageComplete, false);
  assert.equal(first.window.atStart, false);
  assert.ok(!reads.some(read => read.position === 0 && read.bytes > 128), 'initial load must not scan from record zero');
  assert.ok(reads.reduce((sum, read) => sum + read.bytes, 0) < 10 * 1024 * 1024, 'initial I/O must have a bounded budget');
  const count = reads.length;
  for (let i = 0; i < 20; i++) await window.open([file]);
  assert.equal(reads.length, count, 'unchanged refreshes must not read old content or advance history');
  const append = line(message('APPENDED'));
  await fs.appendFile(file, append);
  const next = await window.open([file]);
  assert.ok(has(next, 'APPENDED'));
  assert.ok(reads.slice(count).reduce((sum, read) => sum + read.bytes, 0) <= Buffer.byteLength(append) + 256,
    'live append must reuse already read content instead of rereading the tail window');
});

test('same-directory run files and inserted predecessors cannot collide or reassign existing identities', async t => {
  const { dir, window } = await fixture(t);
  const a = path.join(dir, 'a.jsonl'), b = path.join(dir, 'b.jsonl'), prior = path.join(dir, 'prior.jsonl');
  await fs.writeFile(a, line(message('FROM_A')));
  await fs.writeFile(b, line(message('FROM_B')));
  let snapshot = await toStart(window, [a, b], await window.open([a, b]));
  const ids = new Map(snapshot.entries.filter(entry => entry.kind === 'assistant').map(entry => [entry.text, entry.id]));
  assert.ok(ids.has('FROM_A') && ids.has('FROM_B'));
  assert.notEqual(ids.get('FROM_A'), ids.get('FROM_B'));
  await fs.writeFile(prior, line(message('PREDECESSOR')));
  snapshot = await toStart(window, [prior, a, b], await window.open([prior, a, b]));
  for (const name of ['FROM_A', 'FROM_B']) assert.equal(snapshot.entries.find(entry => entry.text === name)?.id, ids.get(name));
});

test('same-sized middle rewrite invalidates cached text even if both boundary samples are unchanged', async t => {
  const { dir, window } = await fixture(t);
  const file = path.join(dir, 'events.jsonl');
  const before = line(padding(256)) + line(message('OLD_MIDDLE')) + line(padding(256));
  const after = line(padding(256)) + line(message('NEW_MIDDLE')) + line(padding(256));
  assert.equal(Buffer.byteLength(before), Buffer.byteLength(after));
  assert.equal(before.slice(0, 128), after.slice(0, 128));
  assert.equal(before.slice(-128), after.slice(-128));
  await fs.writeFile(file, before);
  assert.ok(has(await window.open([file]), 'OLD_MIDDLE'));
  await fs.writeFile(file, after);
  const changed = new Date(Date.now() + 5000);
  await fs.utimes(file, changed, changed);
  const snapshot = await window.open([file]);
  assert.ok(has(snapshot, 'NEW_MIDDLE'));
  assert.ok(!has(snapshot, 'OLD_MIDDLE'));
});

test('a shorter rewrite invalidates the retained prefix as well as the removed suffix', async t => {
  const { dir, window } = await fixture(t);
  const file = path.join(dir, 'events.jsonl');
  await fs.writeFile(file, line(message('OLD_PREFIX')) + line(padding(4096)));
  assert.ok(has(await window.open([file]), 'OLD_PREFIX'));
  await fs.writeFile(file, line(message('NEW_PREFIX')) + line(padding(128)));
  const snapshot = await window.open([file]);
  assert.ok(has(snapshot, 'NEW_PREFIX'));
  assert.ok(!has(snapshot, 'OLD_PREFIX'));
});

test('parallel tool spans remain separate and replay preserves the newest result and earlier arguments', async t => {
  const { dir, window } = await fixture(t, { initialBytes: 160, pageBytes: 160 });
  const file = path.join(dir, 'events.jsonl');
  const start = id => ({ type: 'tool_execution_start', toolCallId: id, toolName: 'bash', args: { command: `COMMAND_${id}` } });
  const end = id => ({ type: 'tool_execution_end', toolCallId: id, toolName: 'bash', result: { content: [{ type: 'text', text: `FINAL_${id}` }] } });
  const records = [start('A'), start('B'), message('INTERLEAVED'),
    { type: 'tool_execution_update', toolCallId: 'A', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'OLD_PARTIAL_A' }] } },
    end('B'), end('A')];
  await fs.writeFile(file, records.map(line).join(''));
  const snapshot = await toStart(window, [file], await window.open([file]));
  const tools = snapshot.entries.filter(entry => entry.kind === 'tool');
  assert.equal(tools.length, 2);
  assert.equal(new Set(tools.map(entry => entry.id)).size, 2);
  for (const id of ['A', 'B']) {
    const entry = tools.find(entry => entry.text === `FINAL_${id}`);
    assert.ok(entry, `missing newest result of ${id}`);
    assert.equal(JSON.parse(entry.input).command, `COMMAND_${id}`);
    assert.equal(entry.status, 'done');
  }
  assert.ok(has(snapshot, 'INTERLEAVED'));
});

test('all entries stay reachable in both directions when more than 300 messages fit in one byte page', async t => {
  const { dir, window } = await fixture(t);
  const file = path.join(dir, 'events.jsonl');
  await fs.writeFile(file, Array.from({ length: 2000 }, (_, i) => line(message(`MSG_${i}`))).join(''));
  const seen = new Set();
  const visit = snapshot => {
    assert.ok(snapshot.entries.length <= 300, 'display window must stay bounded');
    for (const entry of snapshot.entries) if (/^MSG_\d+$/.test(entry.text)) seen.add(entry.text);
  };
  let snapshot = await toStart(window, [file], await window.open([file]), visit);
  assert.ok(has(snapshot, 'MSG_0'));
  for (let i = 0; !snapshot.window.atEnd && i < 300; i++) { snapshot = await window.pageDown([file]); visit(snapshot); }
  assert.equal(snapshot.window.atEnd, true);
  assert.ok(has(snapshot, 'MSG_1999'));
  assert.equal(seen.size, 2000, 'entry-count clipping must not make byte-cached middle messages unreachable');
});

test('the viewer keeps a paused transcript visible through stat errors and clears the error only after recovery', { timeout: 5000 }, async t => {
  let viewer; t.after(() => viewer?.dispose());
  const { dir, window } = await fixture(t), file = path.join(dir, 'events.jsonl');
  const original = Array.from({ length: 40 }, (_, i) => line(message(`ROW_${String(i).padStart(2, '0')}`))).join('');
  await fs.writeFile(file, original);
  const stat = fs.stat; let denied = false, failures = 0;
  const mock = t.mock.method(fs, 'stat', async (...args) => {
    if (args[0] === file && denied) { failures++; throw Object.assign(new Error('fixture permission denied'), { code: 'EACCES', path: file }); }
    return stat(...args);
  });
  syncBuiltinESMExports(); t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  viewer = new ConversationViewer({ terminal: { rows: 14, columns: 100 }, requestRender() {} },
    { fg: (_, text) => text, bold: text => text }, () => {},
    async () => ({ agent: { id: 'agent', runId: 'run', role: 'worker', phase: 'running' }, ...await window.open([file]) }), { intervalMs: 10 });
  const text = () => viewer.render(100).join('\n');
  await waitUntil('initial transcript', () => text().includes('ROW_39'), 2000);
  viewer.handleInput('\x1b[H'); assert.match(text(), /ROW_00/);
  const firstRow = viewer.render(100)[3], before = window.stats();
  denied = true;
  await waitUntil('repeated stat failures', () => failures >= 2, 2000);
  assert.match(text(), /fixture permission denied/);
  assert.match(text(), /ROW_00/); assert.equal(viewer.render(100)[3], firstRow);
  assert.doesNotMatch(text(), /run logs do not exist|No messages yet/);
  assert.deepEqual(window.stats(), before);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  denied = false;
  const extra = line(message('AFTER_RECOVERY')); await fs.appendFile(file, extra);
  await waitUntil('transcript recovery', () => window.stats().entries === 41 && !text().includes('fixture permission denied'), 2000);
  assert.match(text(), /ROW_00/); assert.equal(viewer.render(100)[3], firstRow);
  viewer.handleInput('\x1b[F'); assert.match(text(), /AFTER_RECOVERY/);
  assert.equal(await fs.readFile(file, 'utf8'), original + extra);
});

test('a still-missing latest run does not invalidate an unchanged readable tail', async t => {
  const { dir, window } = await fixture(t);
  const file = path.join(dir, 'previous.jsonl'), missing = path.join(dir, 'not-created.jsonl');
  await fs.writeFile(file, line(message('PREVIOUS')));
  const reads = trackReads(t);
  assert.ok(has(await window.open([file, missing]), 'PREVIOUS'));
  const count = reads.length;
  for (let i = 0; i < 3; i++) assert.ok(has(await window.open([file, missing]), 'PREVIOUS'));
  assert.equal(reads.length, count, 'known missing files must not force a tail replay every refresh');
});

test('dense delta boundaries count every scan against the initial physical I/O budget', async t => {
  const { dir, window } = await fixture(t);
  const file = path.join(dir, 'dense.jsonl');
  const delta = line({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x' } });
  await fs.writeFile(file, line({ type: 'message_start', message: { role: 'assistant', content: [] } })
    + delta.repeat(Math.ceil(12 * 1024 * 1024 / delta.length)));
  const reads = trackReads(t);
  await window.open([file]);
  const bytes = reads.reduce((total, read) => total + read.bytes, 0);
  assert.ok(bytes > 0, 'the physical I/O probe must be active');
  assert.ok(bytes <= 10 * 1024 * 1024, `boundary scan plus bounded replay read ${bytes} bytes`);
});

test('dispose stops in-flight work before issuing further content reads', { timeout: 2000 }, async t => {
  const { dir, window } = await fixture(t);
  const file = path.join(dir, 'events.jsonl');
  await fs.writeFile(file, line(message('AFTER_DISPOSE')));
  const reads = trackReads(t);
  const observedOpen = fs.open;
  let release, entered, first = true;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  fs.open = async (...args) => {
    if (first) { first = false; entered(); await gate; }
    return observedOpen(...args);
  };
  syncBuiltinESMExports();
  const pending = window.open([file]);
  await started;
  const queued = window.pageUp([file]);
  window.dispose();
  release();
  await Promise.allSettled([pending, queued]);
  assert.equal(reads.length, 0, 'returning from an already-started open must not issue a new read after disposal');
  assert.equal(window.stats().entries, 0, 'cancelled work must not repopulate a disposed window');
});

test('an arbitrary native identity in the tail is not a trusted identity discovery source', async t => {
  const { dir } = await fixture(t);
  for (const cli of ['codex', 'claude']) {
    const file = path.join(dir, `${cli}.jsonl`);
    const foreign = cli === 'codex'
      ? [{ result: { thread: { id: 'FOREIGN' } } }, { method: 'item/completed', params: { threadId: 'FOREIGN', item: { id: 'm', type: 'agentMessage', text: 'FOREIGN_TEXT' } } }]
      : [{ type: 'system', subtype: 'init', session_id: 'FOREIGN' }, { type: 'assistant', session_id: 'FOREIGN', message: { id: 'm', content: [{ type: 'text', text: 'FOREIGN_TEXT' }] } }];
    await fs.writeFile(file, line(padding(64 * 1024)).repeat(40) + foreign.map(line).join(''));
    const window = new TranscriptWindow(cli); t.after(() => window.dispose());
    const snapshot = await window.open([file]);
    assert.match(snapshot.notice ?? '', /identity/i);
    assert.ok(!has(snapshot, 'FOREIGN_TEXT'), `${cli} claimed an arbitrary tail identity despite failed head discovery`);
  }
});

test('a leased window growing beyond the cache budget is detached without discarding the active view', async t => {
  const { dir } = await fixture(t);
  const file = path.join(dir, 'events.jsonl');
  await fs.writeFile(file, line(message('SMALL')));
  const cache = new TranscriptCache({ instances: 4, entries: 1200, bytes: 256 });
  t.after(() => cache.clear());
  const lease = await cache.acquire({ parentFile: path.join(dir, 'parent.jsonl'), agentId: 'a', cli: 'pi' }, [file], () => new TranscriptWindow());
  t.after(() => lease.release());
  await lease.window.open([file]);
  assert.ok(cache.stats().bytes <= 256);
  await fs.appendFile(file, line(message('LARGE_' + 'x'.repeat(2000))));
  const snapshot = await lease.window.open([file]);
  assert.ok(snapshot.entries.some(entry => entry.text.startsWith('LARGE_')));
  assert.ok(cache.stats().bytes <= 256, 'the byte cap must hold before release, not only when closing the viewer');
  assert.ok(lease.window.stats().entries >= 2, 'uncaching must not dispose the active window');
});

test('paging an unattached or empty window settles instead of queueing behind itself', async t => {
  const { dir } = await fixture(t);
  const file = path.join(dir, 'events.jsonl');
  await fs.writeFile(file, line(message('INITIAL')));
  for (const emptyFirst of [false, true]) {
    const window = new TranscriptWindow(); t.after(() => window.dispose());
    if (emptyFirst) await window.open([]);
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), 500); });
    const outcome = await Promise.race([window.pageUp([file]).then(() => 'resolved', () => 'rejected'), timeout]);
    clearTimeout(timer);
    assert.notEqual(outcome, 'timeout', 'pageUp must not call queued open() from inside its own queue task');
  }
});

test('a paused partial entry keeps its position when earlier context changes its record key', async t => {
  const source = path.resolve('.test-output/virtual-span.jsonl');
  const position = offset => ({ source, offset });
  const entry = (id, text, start, end) => ({ id, kind: 'assistant', title: 'Assistant', text,
    span: { start: position(start), end: position(end) } });
  const partial = { ...entry('f@100', 'MARK_PARTIAL', 100, 200), partial: 'head' };
  const tails = Array.from({ length: 15 }, (_, i) => entry(`tail${i}`, `TAIL_${i}`, 201 + i * 10, 210 + i * 10));
  let state = { agent: { id: 'a', role: 'worker', phase: 'running', runId: 'r' },
    entries: [partial, ...tails], loading: false, revision: 1, outputRevision: 1,
    window: { from: position(100), to: position(400), atStart: false, atEnd: true, entries: 16 } };
  let release;
  const viewer = new ConversationViewer({ terminal: { rows: 14, columns: 100 }, requestRender() {} },
    { fg: (_, text) => text, bold: text => text }, () => {}, async () => state,
    { intervalMs: 100000, paging: { older: () => new Promise(resolve => { release = resolve; }),
      newer: async () => state, latest: async () => state } });
  t.after(() => viewer.dispose());
  await new Promise(setImmediate);
  viewer.render(100);
  viewer.handleInput('\x1b[H');
  assert.match(viewer.render(100).join('\n'), /MARK_PARTIAL/);
  state = { ...state, revision: 2, entries: [entry('old1', 'MARK_OLD1', 0, 20), entry('old2', 'MARK_OLD2', 20, 40),
    entry('f@40', 'MARK_PARTIAL', 40, 200), ...tails], window: { ...state.window, from: position(0), atStart: true } };
  release(state);
  await new Promise(setImmediate);
  assert.match(viewer.render(100)[3], /MARK_PARTIAL/, 'span fallback must preserve the reading anchor after rekeying');
});

test('large live records keep catching up and unchanged partial UTF-8 tails are not reread', async t => {
  const { dir, window } = await fixture(t);
  const file = path.join(dir, 'events.jsonl');
  await fs.writeFile(file, line(message('FIRST')));
  await window.open([file]);
  const reads = trackReads(t);
  await fs.appendFile(file, line(message('LARGE_APPEND_' + 'x'.repeat(700 * 1024))));
  let snapshot;
  for (let i = 0; i < 8; i++) {
    const before = reads.reduce((sum, read) => sum + read.bytes, 0);
    snapshot = await window.open([file]);
    if (snapshot.entries.some(entry => entry.text.startsWith('LARGE_APPEND_'))) break;
    assert.ok(reads.reduce((sum, read) => sum + read.bytes, 0) > before,
      'live catch-up must not become a zero-progress history mode or busy loop');
  }
  assert.ok(snapshot.entries.some(entry => entry.text.startsWith('LARGE_APPEND_')));
  const final = Buffer.from(line(message('UTF8_雪_END')));
  const split = final.indexOf(Buffer.from('雪')) + 1;
  await fs.appendFile(file, final.subarray(0, split));
  await window.open([file]);
  const count = reads.length;
  for (let i = 0; i < 3; i++) await window.open([file]);
  assert.equal(reads.length, count, 'incomplete cached record bytes must not be fetched again without an append');
  await fs.appendFile(file, final.subarray(split));
  snapshot = await window.open([file]);
  assert.ok(has(snapshot, 'UTF8_雪_END'));
});

test('releasing during stat preserves the cached page and ordinary reopen remains usable', { timeout: 3000 }, async t => {
  const { dir } = await fixture(t);
  const file = path.join(dir, 'events.jsonl');
  await fs.writeFile(file, line(message('CACHED_PAGE')));
  const cache = new TranscriptCache(); t.after(() => cache.clear());
  const identity = { parentFile: path.join(dir, 'parent.jsonl'), agentId: 'a', cli: 'pi' };
  const lease = await cache.acquire(identity, [file], () => new TranscriptWindow());
  await lease.window.open([file]);
  const before = lease.window.stats();
  const originalStat = fs.stat;
  let release, entered, first = true;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  fs.stat = async (...args) => {
    if (first) { first = false; entered(); await gate; }
    return originalStat(...args);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.stat = originalStat; syncBuiltinESMExports(); });
  const pending = lease.window.open([file]);
  await started; lease.release(); release();
  await Promise.allSettled([pending]);
  assert.equal(lease.window.stats().entries, before.entries, 'cancellation is not a missing-file result');
  const reopened = await cache.acquire(identity, [file], () => new TranscriptWindow());
  t.after(() => reopened.release());
  const snapshot = await reopened.window.open([file]);
  assert.ok(has(snapshot, 'CACHED_PAGE'), 'normal open must recover without needing End/toTail');
  assert.equal(reopened.window.stats().readBytes, before.readBytes, 'unchanged cache should still be reusable');
});

test('a legal MAX_RECORD-sized first record is not skipped while seeking its boundary', async t => {
  const { dir, window } = await fixture(t);
  const file = path.join(dir, 'events.jsonl');
  const marker = 'LEGAL_FIRST_RECORD_';
  const emptySize = Buffer.byteLength(JSON.stringify(message(marker)));
  const record = JSON.stringify(message(marker + 'x'.repeat(4 * 1024 * 1024 - emptySize)));
  assert.equal(Buffer.byteLength(record), 4 * 1024 * 1024);
  await fs.writeFile(file, record + '\n');
  const snapshot = await window.open([file]);
  assert.ok(snapshot.entries.some(entry => entry.text.startsWith(marker)), 'offset zero is a valid boundary, not a fragment to skip');
});

test('paging a single long delta stream keeps both the replay range and physical I/O bounded', async t => {
  const maxBytes = 4 * 1024 * 1024 + 512 * 1024;
  const { dir, window } = await fixture(t, { maxBytes });
  const file = path.join(dir, 'dense.jsonl');
  const delta = line({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x' } });
  await fs.writeFile(file, line({ type: 'message_start', message: { role: 'assistant', content: [] } })
    + delta.repeat(Math.ceil(12 * 1024 * 1024 / delta.length)));
  const reads = trackReads(t);
  await window.open([file]);
  for (let i = 0; i < 3; i++) {
    const before = reads.length;
    await window.pageUp([file]);
    assert.ok(window.stats().windowBytes <= maxBytes, 'one logical message is not permission to retain an ever-growing range');
    const bytes = reads.slice(before).reduce((sum, read) => sum + read.bytes, 0);
    assert.ok(bytes <= 10 * 1024 * 1024, `one older-page request read ${bytes} bytes`);
  }
});

test('releasing one lease twice cannot release another viewer pin', async t => {
  const { dir } = await fixture(t);
  const cache = new TranscriptCache(); t.after(() => cache.clear());
  const identity = { parentFile: path.join(dir, 'parent.jsonl'), agentId: 'a', cli: 'pi' };
  const first = await cache.acquire(identity, [], () => new TranscriptWindow());
  const second = await cache.acquire(identity, [], () => new TranscriptWindow());
  first.release(); first.release();
  assert.equal(cache.stats().pinned, 1, 'the second lease must remain pinned');
  second.release(); assert.equal(cache.stats().pinned, 0);
});

test('an over-budget detached lease still cancels pending work when the viewer closes', { timeout: 3000 }, async t => {
  const { dir } = await fixture(t);
  const file = path.join(dir, 'events.jsonl');
  await fs.writeFile(file, line(message('FIRST')));
  const cache = new TranscriptCache({ bytes: 1 }); t.after(() => cache.clear());
  const lease = await cache.acquire({ parentFile: path.join(dir, 'parent.jsonl'), agentId: 'a', cli: 'pi' }, [file], () => new TranscriptWindow());
  await lease.window.open([file]);
  assert.equal(cache.stats().instances, 0, 'this lease must exercise the detached path');
  const reads = trackReads(t), observedOpen = fs.open;
  let release, entered, first = true;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  fs.open = async (...args) => { if (first) { first = false; entered(); await gate; } return observedOpen(...args); };
  syncBuiltinESMExports();
  await fs.appendFile(file, line(message('UNREAD_APPEND')));
  const pending = lease.window.open([file]);
  await started; lease.release(); release();
  await Promise.allSettled([pending]);
  assert.equal(reads.length, 0, 'cache membership must not control whether a closed viewer cancels reads');
});
