import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TranscriptWindow } from '../dist/ui/transcript-window.js';
import { logSourceKey } from '../dist/ui/transcript.js';

async function fixture(t, messages) {
  const root = path.resolve('.test-output'); await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'display-seek-')), file = path.join(dir, 'events.jsonl');
  const offsets = []; let size = 0;
  const lines = messages.map(content => { offsets.push(size); const line = JSON.stringify({ type: 'message_end', message: { role: 'assistant', content } }) + '\n'; size += Buffer.byteLength(line); return line; });
  await fs.writeFile(file, lines.join(''));
  const window = new TranscriptWindow();
  t.after(async () => { window.dispose(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 30 }); });
  const boundary = i => ({ position: { source: logSourceKey(file), offset: offsets[i] } });
  return { window, file, boundary };
}
const messages = snapshot => snapshot.entries.filter(e => e.kind === 'assistant').map(e => e.text);

test('older seek ends before the displayed boundary even in a dense 5000-message log', async t => {
  const h = await fixture(t, Array.from({ length: 5000 }, (_, i) => `N${i}`));
  await h.window.open([h.file]);
  const older = messages(await h.window.pageUp([h.file], h.boundary(1000)));
  assert.ok(older.length > 0);
  assert.equal(older.at(-1), 'N999');
  assert.ok(older.every(text => Number(text.slice(1)) < 1000));
});

test('newer seek starts immediately after the displayed edge instead of dropping a dense prefix', async t => {
  const h = await fixture(t, Array.from({ length: 5000 }, (_, i) => `N${i}`));
  await h.window.open([h.file]);
  const newer = messages(await h.window.pageDown([h.file], h.boundary(1000)));
  assert.ok(newer.length > 0);
  assert.equal(newer[0], 'N1000');
  assert.ok(newer.every((text, i) => text === `N${1000 + i}`));
  assert.ok(h.window.stats().retainedEntries <= 2000);
});

test('backward seek must not skip a legal multi-megabyte record between display pages', async t => {
  const h = await fixture(t, ['BEFORE', 'BIG_' + 'x'.repeat(3 * 1024 * 1024), 'AFTER']);
  await h.window.open([h.file]);
  const result = await h.window.pageUp([h.file], h.boundary(2));
  assert.ok(messages(result).some(text => text.startsWith('BIG_')));
});

test('forward seeks can finish a legal multi-megabyte record across bounded reads', async t => {
  const h = await fixture(t, ['BEFORE', 'BIG_' + 'x'.repeat(3 * 1024 * 1024), 'AFTER']);
  await h.window.open([h.file]);
  let result;
  for (let i = 0; i < 10; i++) {
    result = await h.window.pageDown([h.file], h.boundary(1));
    if (messages(result).some(text => text.startsWith('BIG_'))) break;
  }
  assert.ok(messages(result).some(text => text.startsWith('BIG_')));
});
