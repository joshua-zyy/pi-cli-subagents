// Process-local reuse of paged transcripts: bounded, identity-scoped and never silently evicted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { TranscriptCache } from '../dist/ui/transcript-cache.js';
import { TranscriptWindow } from '../dist/ui/transcript-window.js';
import { tempDir } from './helpers/tmp.mjs';

const record = text => ({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], usage: { input: 1, output: 1, totalTokens: 2 } } });
const line = value => JSON.stringify(value) + '\n';
const append = (file, text) => fs.appendFileSync(file, line(record(text)));
const identity = (over = {}) => ({ parentFile: 'C:/parent/session.jsonl', agentId: 'agent-1', cli: 'pi', nativeId: 'native-1', ...over });

function workspace(t) {
  const dir = tempDir('cache');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 30 }));
  const file = path.join(dir, 'run-1', 'events.jsonl'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '');
  return { dir, file, files: () => [file] };
}
const create = () => new TranscriptWindow();

test('the same agent identity reuses one window; different scopes never share it', async t => {
  const w = workspace(t); append(w.file, 'FIRST');
  const cache = new TranscriptCache({ instances: 8 }); t.after(() => cache.clear());
  const first = await cache.acquire(identity(), w.files(), create);
  assert.equal(first.reopened, false); assert.equal(first.cached, true);
  const before = first.window.stats();
  first.release();
  const second = await cache.acquire(identity(), w.files(), create);
  assert.equal(second.reopened, true, 'a released window is reused');
  assert.equal(second.window, first.window);
  assert.equal(second.window.stats().readCalls, before.readCalls, 'reuse does not re-read the tail');
  second.release();
  for (const scope of [identity({ agentId: 'agent-2' }), identity({ nativeId: 'native-2' }), identity({ cli: 'claude' }), identity({ parentFile: 'C:/other/session.jsonl' })]) {
    const lease = await cache.acquire(scope, w.files(), create);
    assert.notEqual(lease.window, first.window, 'another scope gets another window');
    lease.release();
  }
  assert.equal(cache.stats().instances, 5);
});

test('a different file list is a different window, and a replaced file resets the reused one', async t => {
  const w = workspace(t); append(w.file, 'ORIGINAL');
  const cache = new TranscriptCache({ instances: 8 }); t.after(() => cache.clear());
  const first = await cache.acquire(identity(), w.files(), create);
  first.release();
  const other = path.join(w.dir, 'run-2', 'events.jsonl'); fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.writeFileSync(other, line(record('SECOND_RUN')));
  const extended = await cache.acquire(identity(), [w.file, other], create);
  assert.notEqual(extended.window, first.window, 'a new run list re-attaches');
  extended.release();
  fs.writeFileSync(w.file, line(record('REPLACED')));
  const future = new Date(Date.now() + 4000); fs.utimesSync(w.file, future, future);
  const reused = await cache.acquire(identity(), [w.file, other], create);
  assert.equal(reused.window, extended.window, 'the cached window object is reused');
  const snapshot = await reused.window.open([w.file, other]);
  assert.ok(snapshot.entries.some(entry => entry.text.includes('REPLACED')), 'a replaced file resets its parsed content');
  assert.ok(!snapshot.entries.some(entry => entry.text.includes('ORIGINAL')));
  reused.release();
});

test('instance, entry and byte limits evict the least recently used unpinned window', async t => {
  const w = workspace(t); append(w.file, 'SHARED');
  const cache = new TranscriptCache({ instances: 2, entries: 300, bytes: 1024 * 1024 }); t.after(() => cache.clear());
  const first = await cache.acquire(identity({ agentId: 'a' }), w.files(), create); first.release();
  const second = await cache.acquire(identity({ agentId: 'b' }), w.files(), create); second.release();
  const third = await cache.acquire(identity({ agentId: 'c' }), w.files(), create); third.release();
  const stats = cache.stats();
  assert.equal(stats.instances, 2, 'the instance cap is honoured');
  assert.ok(stats.entries <= 300); assert.ok(stats.bytes <= 1024 * 1024);
  const again = await cache.acquire(identity({ agentId: 'a' }), w.files(), create);
  assert.equal(again.reopened, false, 'the least recently used window was evicted');
  again.release();
});

test('a pinned window is never evicted and an over-budget acquire is refused instead of silently skipped', async t => {
  const w = workspace(t); append(w.file, 'PINNED');
  const cache = new TranscriptCache({ instances: 1, entries: 300, bytes: 1024 * 1024 }); t.after(() => cache.clear());
  const pinned = await cache.acquire(identity({ agentId: 'pinned' }), w.files(), create);
  const other = await cache.acquire(identity({ agentId: 'other' }), w.files(), create);
  assert.equal(other.cached, false, 'with the only slot pinned, the new window is not cached');
  assert.equal(cache.stats().instances, 1);
  other.release();
  const stillPinned = await cache.acquire(identity({ agentId: 'pinned' }), w.files(), create);
  assert.equal(stillPinned.window, pinned.window, 'the reading anchor survives');
  assert.ok(cache.stats().pinned >= 1);
  stillPinned.release(); pinned.release();
  const after = await cache.acquire(identity({ agentId: 'other' }), w.files(), create);
  assert.equal(after.cached, true, 'released capacity is usable again');
  after.release();
});

test('the cache stays bounded by entries and bytes when windows hold text', async t => {
  const w = workspace(t);
  fs.appendFileSync(w.file, Array.from({ length: 200 }, (_, i) => line(record(`TEXT_${i} ` + 'x'.repeat(2000)))).join(''));
  const cache = new TranscriptCache({ instances: 4, entries: 50, bytes: 200 * 1024 }); t.after(() => cache.clear());
  for (const agentId of ['a', 'b', 'c', 'd', 'e']) {
    const lease = await cache.acquire(identity({ agentId }), w.files(), create);
    await lease.window.open(w.files());
    lease.release();
  }
  const stats = cache.stats();
  assert.ok(stats.instances <= 4, `instances ${stats.instances}`);
  assert.ok(stats.entries <= 50, `entries ${stats.entries}`);
})
;

test('closing a lease stops in-flight reads and the cached window is reused on reopen', async t => {
  const w = workspace(t);
  fs.appendFileSync(w.file, Array.from({ length: 40 }, (_, i) => line(record(`PAGE_${i} ` + 'p'.repeat(2000)))).join(''));
  const paged = () => new TranscriptWindow('pi', undefined, { pageBytes: 512, initialBytes: 512 });
  const cache = new TranscriptCache(); t.after(() => cache.clear());
  const lease = await cache.acquire(identity(), w.files(), paged);
  const first = await lease.window.open(w.files());
  assert.equal(first.window.atStart, false, 'the tail window must have older pages available');
  const kept = lease.window.stats();
  // Hold the first read of the next page, then close the page the way the viewer does on Esc.
  const originalOpen = fsPromises.open;
  const reads = [];
  let releaseGate, enteredGate, gated = false;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  const entered = new Promise(resolve => { enteredGate = resolve; });
  fsPromises.open = async (...args) => {
    const handle = await originalOpen(...args);
    const read = handle.read.bind(handle);
    handle.read = async (...input) => {
      reads.push(Number(input[2] ?? 0));
      if (!gated) { gated = true; enteredGate(); await gate; }
      return read(...input);
    };
    return handle;
  };
  syncBuiltinESMExports();
  t.after(() => { fsPromises.open = originalOpen; syncBuiltinESMExports(); });
  const paging = lease.window.pageUp(w.files());
  await entered;
  lease.release();
  releaseGate();
  await paging;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(reads.length, 1, 'only the already submitted read may finish; a closed page starts no more');
  assert.equal(lease.window.stats().entries, kept.entries, 'the last published window survives the close');
  // The window stays cache-resident and keeps its read progress for the next open.
  const again = await cache.acquire(identity(), w.files(), paged);
  assert.equal(again.window, lease.window);
  assert.equal(again.reopened, true);
  const readsBefore = reads.length;
  await again.window.open(w.files());
  assert.equal(reads.length, readsBefore, 'reopening an unchanged window does not re-read it');
  again.release();
});

test('a detached window reports itself as uncached, keeps its page, and stays usable after release', async t => {
  const w = workspace(t); append(w.file, 'DETACHED');
  const cache = new TranscriptCache({ bytes: 1 }); t.after(() => cache.clear());
  const lease = await cache.acquire(identity(), w.files(), create);
  await lease.window.open(w.files());
  assert.equal(cache.stats().instances, 0, 'an over-budget window is detached, never disposed');
  assert.equal(lease.cached, false, 'the cached flag reflects the detached state, not the acquire-time one');
  assert.ok(lease.window.stats().entries > 0, 'detaching keeps the active view readable');
  lease.release();
  const after = await lease.window.open(w.files());
  assert.ok(after.entries.some(entry => entry.text === 'DETACHED'), 'closing a viewer stops work without dropping the parsed page');
});
