import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TranscriptReader } from '../dist/ui/transcript.js';
import { ConversationViewer } from '../dist/ui/conversation.js';
import { tempDir } from './helpers/tmp.mjs';

const CHUNK = 512 * 1024, WINDOW = 4 * 1024 * 1024 + CHUNK;
const event = (text, input = 1) => ({ type: 'message_end', message: { role: 'assistant', content: text,
  provider: 'fixture', model: 'fixture-model', usage: { input, output: 1, totalTokens: input + 1 } } });
const line = value => JSON.stringify(value) + '\n';
const ignored = bytes => line({ type: 'ignored', padding: 'x'.repeat(bytes) });
function files(t) {
  const dir = tempDir('recent-transcript');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 30 }));
  return { dir, old: path.join(dir, 'old.jsonl'), latest: path.join(dir, 'latest.jsonl') };
}
async function caughtUp(reader, paths) {
  for (let i = 0; i < 150; i++) {
    const snapshot = await reader.readRecent(paths);
    if (!snapshot.historyLoading && !snapshot.loading) return snapshot;
  }
  assert.fail('history did not catch up');
}
const has = (snapshot, text) => snapshot.entries.some(e => e.text.includes(text));

test('first recent read seeks to the latest run, with bounded work and no partial lifetime total', async t => {
  const f = files(t);
  fs.writeFileSync(f.old, line(event('OLD_RUN', 100)) + ignored(2 * CHUNK));
  fs.writeFileSync(f.latest, line(event('LATEST_HEAD', 7)) + ignored(WINDOW + CHUNK) + line(event('LATEST_TAIL', 3)));
  const reader = new TranscriptReader();
  let historyReads = 0, parsedBytes = 0;
  const read = reader.read.bind(reader), consume = TranscriptReader.prototype.consume;
  reader.read = async paths => { historyReads++; return read(paths); };
  t.mock.method(TranscriptReader.prototype, 'consume', function (chunk) { parsedBytes += Buffer.byteLength(chunk); return consume.call(this, chunk); });
  const first = await reader.readRecent([f.old, f.latest]);
  assert.equal(historyReads, 0, 'the first frame must not wait for an old-run read');
  assert.ok(parsedBytes <= WINDOW, 'first-frame parsing is bounded independently of total history');
  assert.ok(has(first, 'LATEST_TAIL')); assert.ok(!has(first, 'OLD_RUN')); assert.ok(!has(first, 'LATEST_HEAD'));
  assert.equal(first.historyLoading, true); assert.equal(first.usage, undefined);
  const outputRevision = first.outputRevision;
  const complete = await caughtUp(reader, [f.old, f.latest]);
  assert.ok(has(complete, 'LATEST_TAIL')); assert.ok(has(complete, 'OLD_RUN'));
  assert.equal(complete.usage.input, 110); assert.equal(complete.usage.output, 3);
  assert.equal(complete.outputRevision, outputRevision, 'reconstruction is not new child output');
  const unchanged = await reader.readRecent([f.old, f.latest]);
  assert.equal(unchanged.revision, complete.revision); assert.deepEqual(unchanged.usage, complete.usage);
});

test('tail refresh stays current while history replays, then hands off without duplicating usage', async t => {
  const f = files(t);
  fs.writeFileSync(f.old, ignored(4 * CHUNK) + line(event('OLD', 50)));
  fs.writeFileSync(f.latest, line(event('RECENT', 10)));
  const reader = new TranscriptReader();
  const first = await reader.readRecent([f.old, f.latest]);
  fs.appendFileSync(f.latest, line(event('NEW_WHILE_REPLAYING', 20)));
  const live = await reader.readRecent([f.old, f.latest]);
  assert.ok(has(live, 'NEW_WHILE_REPLAYING')); assert.equal(live.historyLoading, true);
  assert.ok(live.outputRevision > first.outputRevision); assert.equal(live.usage, undefined);
  const complete = await caughtUp(reader, [f.old, f.latest]);
  assert.equal(complete.entries.filter(e => e.text === 'NEW_WHILE_REPLAYING').length, 1);
  assert.equal(complete.usage.input, 80);
  fs.appendFileSync(f.latest, line(event('AFTER_HANDOFF', 30)));
  const after = await caughtUp(reader, [f.old, f.latest]);
  assert.equal(after.usage.input, 110); assert.ok(has(after, 'AFTER_HANDOFF'));
});

test('tail seeks on record boundaries and retains a partial UTF-8 final record for append', async t => {
  const f = files(t);
  fs.writeFileSync(f.old, ignored(3 * CHUNK));
  const final = Buffer.from(line(event('雪花 AFTER_SPLIT', 2)));
  const split = final.indexOf(Buffer.from('雪')) + 1;
  fs.writeFileSync(f.latest, Buffer.concat([Buffer.from(ignored(WINDOW + CHUNK) + line(event('BEFORE_SPLIT'))), final.subarray(0, split)]));
  const reader = new TranscriptReader();
  const initial = await reader.readRecent([f.old, f.latest]);
  assert.ok(has(initial, 'BEFORE_SPLIT')); assert.ok(!has(initial, 'AFTER_SPLIT'));
  fs.appendFileSync(f.latest, final.subarray(split));
  const live = await reader.readRecent([f.old, f.latest]);
  assert.ok(has(live, '雪花 AFTER_SPLIT'));
  assert.ok(!live.entries.some(e => e.text.includes('\uFFFD')));
  const complete = await caughtUp(reader, [f.old, f.latest]);
  assert.equal(complete.entries.filter(e => e.text === '雪花 AFTER_SPLIT').length, 1);
  assert.equal(complete.usage.input, 3);
});

test('the recent window includes a supported record larger than one incremental read', async t => {
  const f = files(t);
  fs.writeFileSync(f.latest, ignored(WINDOW) + line(event('LARGE_COMPLETE_RECORD ' + '中'.repeat(300_000), 11)));
  const first = await new TranscriptReader().readRecent([f.latest]);
  assert.ok(has(first, 'LARGE_COMPLETE_RECORD'));
  assert.ok(!first.notice?.includes('malformed'), 'seeking into a preceding line is not a malformed record');
});

test('empty or absent latest runs fall back to readable content and can subsequently appear', async t => {
  for (const absent of [false, true]) {
    const f = files(t); fs.writeFileSync(f.old, line(event('PREVIOUS_RUN')));
    if (!absent) fs.writeFileSync(f.latest, '');
    const reader = new TranscriptReader();
    const first = await reader.readRecent([f.old, f.latest]);
    assert.ok(has(first, 'PREVIOUS_RUN'));
    fs.writeFileSync(f.latest, line(event('NEW_RUN_AVAILABLE')));
    const complete = await caughtUp(reader, [f.old, f.latest]);
    assert.ok(has(complete, 'NEW_RUN_AVAILABLE'));
    assert.equal(complete.usage.input, 2);
  }
});

test('a new run arriving during replay is visible before the old history finishes', async t => {
  const f = files(t), nextFile = path.join(f.dir, 'new-run.jsonl');
  fs.writeFileSync(f.old, ignored(10 * CHUNK)); fs.writeFileSync(f.latest, line(event('CURRENT')));
  const reader = new TranscriptReader(); await reader.readRecent([f.old, f.latest]);
  fs.writeFileSync(nextFile, line(event('NEXT_RUN')));
  const next = await reader.readRecent([f.old, f.latest, nextFile]);
  assert.ok(has(next, 'NEXT_RUN')); assert.equal(next.historyLoading, true);
  const complete = await caughtUp(reader, [f.old, f.latest, nextFile]);
  assert.equal(complete.usage.input, 2);
});

test('truncation and replacement restart the recent view instead of reviving stale text or totals', async t => {
  const f = files(t); fs.writeFileSync(f.old, ignored(5 * CHUNK));
  fs.writeFileSync(f.latest, line(event('STALE_MESSAGE', 50)) + ignored(CHUNK));
  const reader = new TranscriptReader(); await reader.readRecent([f.old, f.latest]);
  fs.writeFileSync(f.latest, line(event('FRESH', 2)));
  const reset = await reader.readRecent([f.old, f.latest]);
  assert.ok(has(reset, 'FRESH')); assert.ok(!has(reset, 'STALE_MESSAGE'));
  const complete = await caughtUp(reader, [f.old, f.latest]); assert.equal(complete.usage.input, 2);
  const replacement = path.join(f.dir, 'replacement.jsonl'); fs.writeFileSync(replacement, line(event('REPLACEMENT', 4)));
  const changed = await reader.readRecent([replacement]); assert.ok(has(changed, 'REPLACEMENT')); assert.ok(!has(changed, 'FRESH'));
  assert.equal((await caughtUp(reader, [replacement])).usage.input, 4);
  const empty = await reader.readRecent([]); assert.deepEqual(empty.entries, []); assert.equal(empty.usage, undefined);
});

test('Codex and Claude tails retain native identity filtering without requiring prior historical replay', async t => {
  for (const cli of ['codex', 'claude']) {
    const f = files(t);
    const header = cli === 'codex' ? { result: { thread: { id: 'own' }, model: 'fixture' } }
      : { type: 'system', subtype: 'init', session_id: 'own', model: 'fixture' };
    const record = (id, text) => cli === 'codex'
      ? { method: 'item/completed', params: { threadId: id, item: { type: 'agentMessage', id: text, text } } }
      : { type: 'assistant', session_id: id, message: { id: text, content: [{ type: 'text', text }] } };
    fs.writeFileSync(f.latest, line(header) + ignored(WINDOW + CHUNK) + line(record('foreign', 'FOREIGN')) + line(record('own', 'OWN_TAIL')));
    const reader = new TranscriptReader(cli);
    const first = await reader.readRecent([f.latest]);
    assert.ok(has(first, 'OWN_TAIL')); assert.ok(!has(first, 'FOREIGN'));
  }
});

test('viewer publishes recent content before history, preserves paused position and does not erase a notice on handoff', async t => {
  const frames = [], actions = [];
  const agent = { id: 'agent', role: 'worker', phase: 'running', runId: 'r' };
  const entries = Array.from({ length: 30 }, (_, i) => ({ id: String(i), kind: 'assistant', title: 'Assistant', text: `TAIL_MESSAGE_${i}` }));
  let snapshot = { entries, loading: false, historyLoading: true, revision: 1, outputRevision: 1 };
  const theme = { fg: (_c, text) => text, bold: text => text };
  const tui = { terminal: { rows: 14, columns: 100 }, requestRender() { frames.push(viewer.render(100).join('\n')); } };
  const viewer = new ConversationViewer(tui, theme, action => actions.push(action), async () => ({ agent, ...snapshot }),
    { intervalMs: 10, onSend: async () => { throw Error('SEND_DENIED'); } });
  t.after(() => viewer.dispose());
  const waitFor = async check => { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); } assert.fail('viewer condition not reached'); };
  await waitFor(() => frames.some(frame => frame.includes('TAIL_MESSAGE_29')));
  assert.match(frames[0], /loading history/i);
  viewer.handleInput('\x1b[5~'); // pause above the end
  viewer.handleInput('\r'); viewer.handleInput('hello'); viewer.handleInput('\r');
  await waitFor(() => frames.at(-1).includes('SEND_DENIED'));
  const visible = frames.at(-1).match(/TAIL_MESSAGE_\d+/g);
  const older = Array.from({ length: 20 }, (_, i) => ({ id: `old-${i}`, kind: 'assistant', title: 'Assistant', text: `OLDER_${i}` }));
  snapshot = { entries: [...older, ...entries], loading: false, historyLoading: false, revision: 2, outputRevision: 1 };
  await waitFor(() => frames.at(-1).includes('Paused'));
  assert.deepEqual(frames.at(-1).match(/TAIL_MESSAGE_\d+/g), visible);
  assert.match(frames.at(-1), /SEND_DENIED/);
  viewer.handleInput('\x1b[F'); assert.match(frames.at(-1), /TAIL_MESSAGE_29/);
  viewer.handleInput('\x1b'); assert.deepEqual(actions, [undefined]);
});

test('append at historical EOF is published as live output before the cursor-stable handoff', async t => {
  const f = files(t); fs.writeFileSync(f.old, line(event('OLD', 10))); fs.writeFileSync(f.latest, line(event('TAIL', 20)));
  const reader = new TranscriptReader(); let injected = false;
  const read = reader.read.bind(reader);
  reader.read = async paths => {
    const snapshot = await read(paths);
    if (!snapshot.loading && !injected) { injected = true; fs.appendFileSync(f.latest, line(event('RACING_APPEND', 30))); }
    return snapshot;
  };
  await reader.readRecent([f.old, f.latest]);
  let raced;
  for (let i = 0; i < 10; i++) { raced = await reader.readRecent([f.old, f.latest]); if (has(raced, 'RACING_APPEND')) break; }
  assert.ok(has(raced, 'RACING_APPEND')); assert.equal(raced.historyLoading, true);
  const outputRevision = raced.outputRevision;
  const full = await caughtUp(reader, [f.old, f.latest]);
  assert.equal(full.outputRevision, outputRevision); assert.equal(full.usage.input, 60);
});

test('continuous appends stay visible without resetting the historical reader or counting twice', async t => {
  const f = files(t); fs.writeFileSync(f.latest, line(event('BEGIN', 2)));
  const reader = new TranscriptReader(); let previous = await reader.readRecent([f.latest]);
  for (let i = 0; i < 12; i++) {
    fs.appendFileSync(f.latest, line(event(`APPEND_${i}`, 1)));
    const next = await reader.readRecent([f.latest]);
    assert.ok(has(next, `APPEND_${i}`)); assert.equal(next.historyLoading, true);
    assert.ok(next.revision > previous.revision); assert.ok(next.outputRevision > previous.outputRevision);
    previous = next;
  }
  const full = await caughtUp(reader, [f.latest]); assert.equal(full.usage.input, 14);
});

test('native cumulative totals after handoff match a plain sequential reader for Codex and Claude', async t => {
  for (const cli of ['codex', 'claude']) {
    const f = files(t);
    const usage = input => cli === 'codex'
      ? { method: 'thread/tokenUsage/updated', params: { threadId: 'own', tokenUsage: { total: { inputTokens: input, cachedInputTokens: 10, outputTokens: 5 } } } }
      : { type: 'result', subtype: 'success', session_id: 'own', result: 'done', uuid: String(input), modelUsage: { m: { inputTokens: input, outputTokens: 5, cacheReadInputTokens: 10, cacheCreationInputTokens: 2 } }, total_cost_usd: 0.1 };
    fs.writeFileSync(f.old, line(usage(50)) + ignored(2 * CHUNK));
    fs.writeFileSync(f.latest, line(usage(80)) + line(usage(120)));
    const recent = new TranscriptReader(cli, 'own'), sequential = new TranscriptReader(cli, 'own');
    assert.equal((await recent.readRecent([f.old, f.latest])).usage, undefined);
    const full = await caughtUp(recent, [f.old, f.latest]);
    let expected; do { expected = await sequential.read([f.old, f.latest]); } while (expected.loading);
    assert.deepEqual(full.usage, expected.usage);
  }
});

test('oversized unfinished records are skipped consistently and do not eat the next valid record', async t => {
  const f = files(t); fs.writeFileSync(f.latest, line(event('PRIOR')) + '{"padding":"' + 'x'.repeat(WINDOW + CHUNK));
  const reader = new TranscriptReader();
  const preview = await reader.readRecent([f.latest]); assert.match(preview.notice, /older|oversized/);
  fs.appendFileSync(f.latest, '"}\n' + line(event('VALID_AFTER_OVERSIZE', 4)));
  const full = await caughtUp(reader, [f.latest]);
  assert.ok(has(full, 'VALID_AFTER_OVERSIZE')); assert.equal(full.usage.input, 5);
  assert.match(full.notice, /oversized/);
});

test('snapshot copies and a post-handoff truncation cannot leak old text or mutate totals', async t => {
  const f = files(t); fs.writeFileSync(f.latest, line(event('ORIGINAL', 40)) + ignored(CHUNK));
  const reader = new TranscriptReader();
  const preview = await reader.readRecent([f.latest]); preview.entries[0].text = 'MUTATED';
  const full = await caughtUp(reader, [f.latest]); assert.ok(!has(full, 'MUTATED'));
  full.usage.input = 999; assert.equal((await reader.readRecent([f.latest])).usage.input, 40);
  fs.writeFileSync(f.latest, line(event('RESTARTED', 3)));
  const reset = await reader.readRecent([f.latest]); assert.ok(has(reset, 'RESTARTED')); assert.ok(!has(reset, 'ORIGINAL'));
  assert.equal((await caughtUp(reader, [f.latest])).usage.input, 3);
});

test('an arbitrary tail response cannot establish an unknown native identity', async t => {
  const f = files(t);
  fs.writeFileSync(f.latest, ignored(WINDOW + CHUNK) + line({ result: { thread: { id: 'foreign' } } }) +
    line({ method: 'item/completed', params: { threadId: 'foreign', item: { type: 'agentMessage', id: 'x', text: 'UNTRUSTED_TAIL_IDENTITY' } } }));
  const first = await new TranscriptReader('codex').readRecent([f.latest]);
  assert.ok(!has(first, 'UNTRUSTED_TAIL_IDENTITY')); assert.match(first.notice, /identity/);
});

test('the real recent reader reaches the first viewer frame before historical parsing', async t => {
  const f = files(t); fs.writeFileSync(f.old, line(event('OLD_FRAME')) + ignored(3 * CHUNK)); fs.writeFileSync(f.latest, line(event('FIRST_TAIL_FRAME')));
  const reader = new TranscriptReader(); let historyReads = 0, firstFrame;
  const read = reader.read.bind(reader); reader.read = async paths => { historyReads++; return read(paths); };
  const agent = { id: 'agent', role: 'worker', phase: 'running', runId: 'r' };
  const tui = { terminal: { rows: 14, columns: 100 }, requestRender() { if (!firstFrame) firstFrame = { text: viewer.render(100).join('\n'), historyReads }; } };
  const viewer = new ConversationViewer(tui, { fg: (_c, t) => t, bold: t => t }, () => {}, async () => ({ agent, ...await reader.readRecent([f.old, f.latest]) }));
  t.after(() => viewer.dispose());
  for (let i = 0; i < 100 && !firstFrame; i++) await new Promise(r => setTimeout(r, 5));
  viewer.dispose();
  assert.match(firstFrame.text, /FIRST_TAIL_FRAME/); assert.doesNotMatch(firstFrame.text, /OLD_FRAME/);
  assert.equal(firstFrame.historyReads, 0);
});

test('background identity discovery rebuilds an initially unclaimed native tail', async t => {
  for (const cli of ['codex', 'claude']) {
    const f = files(t);
    const init = cli === 'codex' ? { result: { thread: { id: 'own' } } } : { type: 'system', session_id: 'own', subtype: 'init' };
    const message = id => cli === 'codex'
      ? { method: 'item/completed', params: { threadId: id, item: { type: 'agentMessage', id, text: `${id}_OUTPUT` } } }
      : { type: 'assistant', session_id: id, message: { id, content: [{ type: 'text', text: `${id}_OUTPUT` }] } };
    fs.writeFileSync(f.latest, ignored(2 * CHUNK) + line(init) + ignored(WINDOW + CHUNK) + line(message('foreign')) + line(message('own')));
    const reader = new TranscriptReader(cli);
    const first = await reader.readRecent([f.latest]); assert.ok(!has(first, 'own_OUTPUT'));
    let learned;
    for (let i = 0; i < 10; i++) { learned = await reader.readRecent([f.latest]); if (has(learned, 'own_OUTPUT')) break; }
    assert.ok(has(learned, 'own_OUTPUT')); assert.ok(!has(learned, 'foreign_OUTPUT'));
    assert.equal(learned.historyLoading, true);
  }
});

test('coalesced append and handoff renders preserve the paused viewport', async t => {
  const agent = { id: 'agent', role: 'worker', phase: 'running', runId: 'r' };
  const entries = Array.from({ length: 30 }, (_, i) => ({ id: String(i), kind: 'assistant', title: 'Assistant', text: `COALESCED_${i}` }));
  const pending = []; let calls = 0, renderRequests = 0;
  const waitFor = async check => { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); } assert.fail('coalescing condition not reached'); };
  const tui = { terminal: { rows: 14, columns: 100 }, requestRender() { renderRequests++; } };
  const viewer = new ConversationViewer(tui, { fg: (_c, t) => t, bold: t => t }, () => {}, async () => {
    if (++calls === 1) return { agent, entries, loading: false, historyLoading: true, revision: 1, outputRevision: 1 };
    return new Promise(resolve => pending.push(resolve));
  }, { intervalMs: 10 });
  t.after(() => viewer.dispose());
  await waitFor(() => renderRequests > 0); viewer.render(100);
  viewer.handleInput('\x1b[5~');
  const visible = viewer.render(100).join('\n').match(/COALESCED_\d+/g);
  await waitFor(() => pending.length > 0);
  const appended = [...entries, { id: 'new', kind: 'assistant', title: 'Assistant', text: 'LIVE_APPEND' }];
  let before = renderRequests;
  pending.shift()({ agent, entries: appended, loading: false, historyLoading: true, revision: 2, outputRevision: 2 });
  await waitFor(() => renderRequests > before);
  // Deliberately do NOT render the append frame, as a host may coalesce render requests.
  await waitFor(() => pending.length > 0);
  before = renderRequests;
  const old = Array.from({ length: 20 }, (_, i) => ({ id: `old-${i}`, kind: 'assistant', title: 'Assistant', text: `OLD_${i}` }));
  pending.shift()({ agent, entries: [...old, ...appended], loading: false, historyLoading: false, revision: 3, outputRevision: 2 });
  await waitFor(() => renderRequests > before);
  // A further append can also be coalesced after handoff; it is not part of the history prepend.
  await waitFor(() => pending.length > 0);
  before = renderRequests;
  pending.shift()({ agent, entries: [...old, ...appended, { id: 'later', kind: 'assistant', title: 'Assistant', text: 'LATER_APPEND' }],
    loading: false, historyLoading: false, revision: 4, outputRevision: 3 });
  await waitFor(() => renderRequests > before);
  assert.deepEqual(viewer.render(100).join('\n').match(/COALESCED_\d+/g), visible);
  viewer.handleInput('\x1b[F'); assert.match(viewer.render(100).join('\n'), /LIVE_APPEND/);
});
