import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { readActivity } from '../dist/activity.js';

const line = value => JSON.stringify(value) + '\n';
const message = content => ({ type: 'message_end', message: { role: 'assistant', content } });
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
async function fixture(t, records = []) {
  const root = path.resolve('.test-output'); await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'activity-')), file = path.join(dir, 'events.jsonl');
  await fs.writeFile(file, records.map(line).join(''));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 30 }));
  return { dir, file, request: { id: 'instance', cli: 'pi', files: [file] } };
}
function reads(t, onRead = () => {}) {
  const original = fs.open, result = [];
  fs.open = async (...args) => {
    const handle = await original(...args), read = handle.read.bind(handle);
    handle.read = async (...input) => {
      const value = await read(...input);
      const item = { file: String(args[0]), offset: input[3], bytes: value.bytesRead };
      result.push(item); onRead(item); return value;
    };
    return handle;
  };
  syncBuiltinESMExports();
  t.after(() => { fs.open = original; syncBuiltinESMExports(); });
  return result;
}
async function allPages(request) {
  const pages = []; let cursor;
  for (let i = 0; i < 300; i++) {
    const page = await readActivity({ ...request, cursor }); pages.push(page);
    assert.ok(bytes(page) <= (request.maxBytes ?? 16384));
    if (!page.hasMore) { assert.equal(page.cursor, undefined); return pages; }
    assert.equal(typeof page.cursor, 'string'); assert.notEqual(page.cursor, cursor);
    cursor = page.cursor;
  }
  assert.fail('pagination did not terminate');
}

test('activity defaults to 20 newest entries in chronological order and projects stable opaque ids', async t => {
  const h = await fixture(t, Array.from({ length: 55 }, (_, i) => message(`M${i}`)));
  const page = await readActivity(h.request);
  assert.deepEqual(page.entries.map(e => e.text), Array.from({ length: 20 }, (_, i) => `M${i + 35}`));
  const allowed = new Set(['id', 'kind', 'title', 'text', 'input', 'status', 'partial', 'truncated', 'omittedBytes']);
  for (const e of page.entries) { assert.ok(Object.keys(e).every(key => allowed.has(key))); assert.ok(!e.id.includes(h.dir)); assert.match(e.id, /^[A-Za-z0-9_-]{43}$/); }
  assert.deepEqual((await readActivity(h.request)).entries, page.entries);
  const pages = await allPages(h.request);
  assert.deepEqual(pages.reverse().flatMap(p => p.entries.map(e => e.text)), Array.from({ length: 55 }, (_, i) => `M${i}`));
});

test('byte-budget evictions and same-record sibling entries remain reachable with limit=1', async t => {
  const content = [{ type: 'text', text: 'assistant' }, ...Array.from({ length: 12 }, (_, i) => ({ type: 'toolCall', id: `t${i}`, name: `Tool${i}`, arguments: { file: `/legitimate/path/${i}`, value: '中'.repeat(4000) } }))];
  const h = await fixture(t, [message(content)]);
  const pages = await allPages({ ...h.request, limit: 1, maxBytes: 4096 });
  const entries = pages.reverse().flatMap(p => p.entries);
  assert.deepEqual(entries.map(e => e.title), ['Assistant', ...Array.from({ length: 12 }, (_, i) => `Tool${i}`)]);
  assert.ok(entries.slice(1).every(e => e.input.includes('/legitimate/path/')));
  assert.equal(new Set(entries.map(e => e.id)).size, 13);
});

for (const count of [3000, 20000]) {
  test(`same-record siblings remain reachable across ${count} long-span tool updates`, async t => {
    const content = [{ type: 'text', text: 'assistant' }, ...Array.from({ length: 4 }, (_, i) => ({
      type: 'toolCall', id: `s${i}`, name: `S${i}`, arguments: { value: 'x' },
    }))];
    const updates = Array.from({ length: count }, () => ({ type: 'tool_execution_update', toolCallId: 's3', toolName: 'S3',
      partialResult: { content: [{ type: 'text', text: 'u'.repeat(120) }] } }));
    const h = await fixture(t, [message(content), ...updates, message('NEWEST')]);
    const pages = await allPages({ ...h.request, limit: 1, maxBytes: 4096 });
    const entries = pages.reverse().flatMap(page => page.entries), unique = new Map(), repeated = [];
    for (const entry of entries) {
      if (unique.has(entry.id)) repeated.push(entry); else unique.set(entry.id, entry);
    }
    assert.deepEqual([...unique.values()].map(entry => entry.title), ['Assistant', 'S0', 'S1', 'S2', 'S3', 'Assistant']);
    assert.equal(entries.at(-1).text, 'NEWEST');
    assert(repeated.length > 0, 'the fixture must exercise cross-page fragments');
    assert(repeated.every(entry => entry.partial === 'head'), 'repeated entries must disclose their missing head');
  });
}

test('UTF-8 JSON budget counts escaping and source clipping, never the synthetic marker', async t => {
  const text = '中😀\\\"\n'.repeat(10000), input = { command: '/valid/path', value: text };
  const h = await fixture(t, [{ type: 'tool_execution_start', toolCallId: 't', toolName: 'tool', args: input }, { type: 'tool_execution_end', toolCallId: 't', toolName: 'tool', result: { content: text } }]);
  const page = await readActivity({ ...h.request, maxBytes: 4096 });
  const e = page.entries[0];
  assert.ok(bytes(page) <= 4096); assert.equal(e.truncated, true);
  assert.equal(e.omittedBytes, bytes(text) + bytes(JSON.stringify(input, null, 2)) - bytes(e.text) - bytes(e.input));
  assert.ok(!e.text.includes('[Content clipped;')); assert.ok(!e.input.includes('[Content clipped;'));
  assert.ok(e.text.isWellFormed() && e.input.isWellFormed());
});

test('streamed omissions accumulate once and authoritative snapshots replace prior omission counts', async t => {
  const a = '😀'.repeat(16000), b = '中'.repeat(8000);
  const h = await fixture(t, [{ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: a } }, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: b } }]);
  let page = await readActivity({ ...h.request, maxBytes: 65536 });
  assert.equal(page.entries[0].omittedBytes, bytes(a + b) - bytes(page.entries[0].text));
  await fs.appendFile(h.file, line({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'block authoritative' } }));
  page = await readActivity(h.request);
  assert.equal(page.entries[0].text, 'block authoritative');
  assert.equal(page.entries[0].omittedBytes, undefined); assert.equal(page.entries[0].truncated, undefined);
  await fs.appendFile(h.file, line(message('authoritative')));
  page = await readActivity(h.request);
  assert.equal(page.entries[0].text, 'authoritative'); assert.equal(page.entries[0].omittedBytes, undefined); assert.equal(page.entries[0].truncated, undefined);
});

test('literal clip-marker text is not mistaken for a measured omission', async t => {
  const h = await fixture(t, [message('Literal: [Content clipped; see the original event log.]')]);
  const e = (await readActivity(h.request)).entries[0];
  assert.equal(e.omittedBytes, undefined); assert.equal(e.truncated, undefined);
});

test('old cursor survives append and does not reread the latest tail', async t => {
  const h = await fixture(t, Array.from({ length: 12000 }, (_, i) => message(`M${i}:` + 'x'.repeat(450))));
  const first = await readActivity({ ...h.request, limit: 5 });
  const oldSize = (await fs.stat(h.file)).size;
  await fs.appendFile(h.file, Array.from({ length: 12000 }, (_, i) => line(message(`APPEND${i}:` + 'x'.repeat(450)))).join(''));
  const io = reads(t);
  const older = await readActivity({ ...h.request, cursor: first.cursor, limit: 5 });
  assert.ok(older.entries.length > 0); assert.ok(older.entries.every(e => !e.text.startsWith('APPEND')));
  assert.ok(io.every(r => r.offset + r.bytes <= oldSize), 'cursor reads must not visit the newer tail');
  assert.ok(io.reduce((n, r) => n + r.bytes, 0) < 2 * 1024 * 1024, 'one cursor page must have bounded physical reads');
});

test('malformed, cross-instance, cross-CLI and cross-native-identity cursors fail rather than returning tail', async t => {
  const h = await fixture(t, [message('A'), message('B')]);
  const page = await readActivity({ ...h.request, limit: 1 });
  for (const patch of [{ cursor: 'garbage' }, { cursor: page.cursor + '!' }, { id: 'other' }, { cli: 'claude' }, { threadId: 'other-thread' }]) {
    await assert.rejects(readActivity({ ...h.request, cursor: page.cursor, ...patch }), /cursor/i);
  }
});

for (const mutation of ['missing', 'replace', 'shrink', 'anchor-rewrite', 'same-size-rewrite']) {
  test(`cursor rejects ${mutation}`, async t => {
    const h = await fixture(t, Array.from({ length: 12 }, (_, i) => message(`M${i}`)));
    const page = await readActivity({ ...h.request, limit: 2 }), original = await fs.readFile(h.file);
    if (mutation === 'missing') await fs.unlink(h.file);
    if (mutation === 'replace') { await fs.rename(h.file, h.file + '.old'); await fs.writeFile(h.file, original); }
    if (mutation === 'shrink') await fs.truncate(h.file, 8);
    if (mutation === 'anchor-rewrite') await fs.writeFile(h.file, original.toString().replace('M10', 'X10') + line(message('APPEND')));
    if (mutation === 'same-size-rewrite') { await fs.writeFile(h.file, original.toString().replace('M1', 'X1')); const changed = new Date(Date.now() + 5000); await fs.utimes(h.file, changed, changed); }
    await assert.rejects(readActivity({ ...h.request, cursor: page.cursor }), /cursor/i);
  });
}

test('malformed records, absent logs and oversized records preserve notice without claiming completeness', async t => {
  const h = await fixture(t, [message('BEFORE')]);
  await fs.appendFile(h.file, 'bad json\n' + line({ ignored: 'x'.repeat(5 * 1024 * 1024) }) + line(message('AFTER')));
  const pages = await allPages({ ...h.request, files: [path.join(h.dir, 'missing.jsonl'), h.file] });
  assert.ok(pages.some(p => /malformed|oversized|clipped|unavailable|missing/i.test(p.notice ?? '')));
  assert.ok(pages.flatMap(p => p.entries).some(e => e.text === 'BEFORE'));
  assert.ok(pages.flatMap(p => p.entries).some(e => e.text === 'AFTER'));
  assert.ok(!pages.some(p => /history is complete|\bcomplete log/i.test(p.notice ?? '')));
});

test('empty log returns an empty page; pre-cancel and in-flight cancel reject with original reason', async t => {
  const h = await fixture(t);
  assert.deepEqual((await readActivity(h.request)).entries, []);
  const before = new AbortController(), reason = new Error('fixture cancellation'); before.abort(reason);
  await assert.rejects(readActivity({ ...h.request, signal: before.signal }), e => e === reason);
  await fs.writeFile(h.file, Array.from({ length: 1000 }, (_, i) => line(message(String(i)))).join(''));
  const during = new AbortController(), io = reads(t, () => during.abort(reason));
  await assert.rejects(readActivity({ ...h.request, signal: during.signal }), e => e === reason);
  assert.equal(io.length, 1, "cancelled queries must not initiate another content read");
});

for (const cli of ['codex', 'claude']) {
  test(`activity reuses ${cli} native identity parsing without a running CLI`, async t => {
    const text = '中'.repeat(30000);
    const records = cli === 'codex'
      ? [{ result: { thread: { id: 'thread' } } }, { method: 'item/completed', params: { threadId: 'wrong', item: { id: 'wrong', type: 'agentMessage', text: 'FOREIGN' } } }, { method: 'item/completed', params: { threadId: 'thread', item: { id: 'right', type: 'agentMessage', text } } }]
      : [{ type: 'system', session_id: 'thread' }, { type: 'assistant', session_id: 'wrong', message: { id: 'wrong', content: 'FOREIGN' } }, { type: 'assistant', session_id: 'thread', message: { id: 'right', content: text } }];
    const h = await fixture(t, records), page = await readActivity({ ...h.request, cli });
    assert.equal(page.entries.length, 1); assert.ok(page.entries[0].text.startsWith('中'));
    assert.equal(page.entries[0].omittedBytes, bytes(text) - bytes(page.entries[0].text));
  });
}

test('limit and byte bounds reject non-integral or out-of-range requests', async t => {
  const h = await fixture(t);
  for (const patch of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { maxBytes: 4095 }, { maxBytes: 65537 }, { maxBytes: NaN }]) await assert.rejects(readActivity({ ...h.request, ...patch }), /limit|maxBytes/);
});


test('JSON-budget drops recompute the older cursor rather than hiding discarded entries', async t => {
  const h = await fixture(t, Array.from({ length: 27 }, (_, i) => message(i + ':' + '中'.repeat(1800))));
  const pages = await allPages({ ...h.request, maxBytes: 4096 });
  assert.ok(pages.length > 2, 'byte budget, not the 20-entry limit, must force the evictions');
  assert.deepEqual(pages.reverse().flatMap(p => p.entries.map(e => Number(e.text.split(':')[0]))), Array.from({ length: 27 }, (_, i) => i));
});

test('cross-file pages preserve order and gaps; appending run paths preserves an old cursor', async t => {
  const h = await fixture(t, Array.from({ length: 11 }, (_, i) => message('A' + i)));
  const b = path.join(h.dir, 'b.jsonl'), missing = path.join(h.dir, 'missing.jsonl'), c = path.join(h.dir, 'c.jsonl');
  await fs.writeFile(b, Array.from({ length: 11 }, (_, i) => line(message('B' + i))).join(''));
  const request = { ...h.request, files: [h.file, missing, b], limit: 4 };
  const first = await readActivity(request);
  await fs.writeFile(c, line(message('NEW_RUN')));
  const next = await readActivity({ ...request, files: [...request.files, c], cursor: first.cursor });
  assert.ok(next.entries.every(e => e.text !== 'NEW_RUN'));
  assert.deepEqual(await readActivity({ ...request, cursor: first.cursor }), await readActivity({ ...request, cursor: first.cursor }));
  const pages = await allPages(request);
  assert.deepEqual(pages.reverse().flatMap(p => p.entries.map(e => e.text)), ['A', 'B'].flatMap(prefix => Array.from({ length: 11 }, (_, i) => prefix + i)));
  assert.ok(pages.some(page => /unavailable/i.test(page.notice ?? '')));
  await assert.rejects(readActivity({ ...request, files: [b], cursor: first.cursor }), /cursor/i);
  for (const files of [[c, ...request.files], [h.file, missing, c, b]]) {
    await assert.rejects(readActivity({ ...request, files, cursor: first.cursor }), /source list no longer matches/i);
  }
});

test('discovered native identity travels in the cursor so old native pages never scan the head', async t => {
  const records = [{ result: { thread: { id: 'native' } } }, ...Array.from({ length: 4000 }, (_, i) => ({ method: 'item/completed', params: { threadId: 'native', item: { id: String(i), type: 'agentMessage', text: i + ':' + 'x'.repeat(500) } } }))];
  const h = await fixture(t, records), request = { ...h.request, cli: 'codex', limit: 3 };
  const first = await readActivity(request), io = reads(t);
  const second = await readActivity({ ...request, cursor: first.cursor });
  assert.equal(second.entries.length, 3); assert.ok(io.length > 0);
  assert.ok(io.every(read => read.offset > 0), 'a cursor must not relearn native identity by replaying the head');
});

test('a reader-level permission failure is an error, not a successful empty live tail', async t => {
  const h = await fixture(t, [message('READ_ME')]), original = fs.open;
  fs.open = async (...args) => { if (String(args[0]) === h.file) throw Object.assign(new Error('fixture read denied'), { code: 'EACCES' }); return original(...args); };
  syncBuiltinESMExports(); t.after(() => { fs.open = original; syncBuiltinESMExports(); });
  await assert.rejects(readActivity(h.request), /fixture read denied/);
});

test('the bounded generation witness does not claim to detect a far rewrite followed by growth', async t => {
  const h = await fixture(t, Array.from({ length: 100 }, (_, i) => message('M' + String(i).padStart(3, '0'))));
  const first = await readActivity({ ...h.request, limit: 2 });
  const changed = (await fs.readFile(h.file, 'utf8')).replace('M000', 'X000') + line(message('APPENDED'));
  await fs.writeFile(h.file, changed);
  const next = await readActivity({ ...h.request, limit: 2, cursor: first.cursor });
  assert.deepEqual(next.entries.map(e => e.text), ['M096', 'M097']);
});

test('window text-budget trimming inside one record cannot advertise the first page as complete', async t => {
  let nested = {}; for (let i = 0; i < 100; i++) nested = { child: nested };
  const args = { value: '中'.repeat(10000), nested };
  const h = await fixture(t, [message(Array.from({ length: 100 }, (_, i) => ({ type: 'toolCall', id: String(i), name: 'T' + i, arguments: args })))]);
  const request = { ...h.request, limit: 100, maxBytes: 65536 };
  const first = await readActivity(request);
  assert.equal(first.hasMore, true); assert.deepEqual(first.entries.map(e => e.title), ['T99']);
  const second = await readActivity({ ...request, cursor: first.cursor });
  assert.equal(second.hasMore, true); assert.deepEqual(second.entries.map(e => e.title), ['T98']);
});

test('oversized native title and native id cannot escape the JSON budget or opaque-id contract', async t => {
  const title = '中😀'.repeat(10000), h = await fixture(t, [{ type: 'tool_execution_start', toolCallId: '/raw/identity/'.repeat(2000), toolName: title, args: { path: '/valid/input' } }]);
  const page = await readActivity({ ...h.request, maxBytes: 4096 }), e = page.entries[0];
  assert.ok(bytes(page) <= 4096); assert.match(e.id, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(e.omittedBytes, bytes(title) - bytes(e.title)); assert.ok(e.title.isWellFormed());
  assert.match(e.input, /valid\/input/);
});

test('semantically malformed projection fields are skipped with a notice, not returned as raw objects', async t => {
  const h = await fixture(t, [{ type: 'tool_execution_start', toolCallId: 't', toolName: { raw: { frame: 'must not escape' } }, args: {} }, message('VALID')]);
  const page = await readActivity(h.request);
  assert.ok(page.entries.every(e => typeof e.title === 'string'));
  assert.ok(page.entries.some(e => e.text === 'VALID')); assert.match(page.notice, /malformed/i);
});

test('an emitted cursor remains decodable throughout the allowed 64 KiB envelope', async t => {
  const h = await fixture(t, [message('A'), message('B')]), request = { ...h.request, id: 'i'.repeat(6000), limit: 1, maxBytes: 65536 };
  const first = await readActivity(request);
  assert.deepEqual((await readActivity({ ...request, cursor: first.cursor })).entries.map(e => e.text), ['A']);
});

test('a historical file growing after planning cannot overrun the physical page-read budget', async t => {
  const h = await fixture(t, [message('A')]), b = path.join(h.dir, 'b.jsonl');
  await fs.writeFile(b, line(message('B')));
  const request = { ...h.request, files: [h.file, b], limit: 1 }, first = await readActivity(request);
  const original = fs.open; let grew = false, consumed = 0;
  fs.open = async (...args) => {
    if (String(args[0]) === h.file && !grew) { grew = true; await fs.appendFile(h.file, line({ ignored: 'x'.repeat(1024) }).repeat(12000)); }
    const handle = await original(...args), read = handle.read.bind(handle);
    handle.read = async (...input) => { const result = await read(...input); consumed += result.bytesRead; return result; };
    return handle;
  };
  syncBuiltinESMExports(); t.after(() => { fs.open = original; syncBuiltinESMExports(); });
  const page = await readActivity({ ...request, cursor: first.cursor });
  assert.ok(page.entries.some(entry => entry.text === 'A'));
  assert.ok(consumed <= 6 * 1024 * 1024, 'metadata-time geometry is not a physical I/O budget: ' + consumed);
});
