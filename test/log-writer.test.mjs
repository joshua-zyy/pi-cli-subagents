import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LogWriter, pruneRunLogs } from '../dist/log-writer.js';
import { waitUntil } from '../dist/storage.js';
import { tempDir } from './helpers/tmp.mjs';

test('a rotated log keeps the previous file intact and writes new bytes to the new one', async () => {
  const dir = tempDir('log-writer');
  const first = path.join(dir, 'events.jsonl'), second = path.join(dir, 'next.jsonl');
  const writer = new LogWriter(first, () => {});
  writer.stream.write('one\n');
  writer.rotate(second);
  writer.stream.write('two\n');
  writer.end();
  await waitUntil('rotated log flush', () => fs.existsSync(second) && fs.readFileSync(second, 'utf8').includes('two'), 2000);
  assert.equal(fs.readFileSync(first, 'utf8'), 'one\n');
  assert.equal(fs.readFileSync(second, 'utf8'), 'two\n');
  assert.ok(fs.existsSync(`${first}.stderr`), 'the launch run keeps the stderr companion');
  assert.equal(fs.existsSync(`${second}.stderr`), false, 'a rotated stream does not move the stderr companion');
});

test('pruning removes the oldest raw streams, never the starting run, and touches nothing else', () => {
  const dir = tempDir('log-prune'), runs = path.join(dir, 'runs');
  const oldest = '11111111-1111-4111-8111-111111111111';
  const middle = '22222222-2222-4222-8222-222222222222';
  const current = '33333333-3333-4333-8333-333333333333';
  for (const [runId, seconds] of [[oldest, 1], [middle, 2], [current, 3]]) {
    fs.mkdirSync(path.join(runs, runId), { recursive: true });
    fs.writeFileSync(path.join(runs, runId, 'events.jsonl'), 'x'.repeat(300));
    fs.writeFileSync(path.join(runs, runId, 'events.jsonl.stderr'), 'e');
    fs.writeFileSync(path.join(runs, runId, 'request.json'), '{}');
    fs.utimesSync(path.join(runs, runId, 'events.jsonl'), seconds, seconds);
  }
  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'reports', 'run-result.json'), '{}');
  fs.writeFileSync(path.join(dir, 'state.json'), '{}');

  assert.deepEqual(pruneRunLogs(dir, current, 700), [path.join(runs, oldest, 'events.jsonl')]);
  assert.equal(fs.existsSync(path.join(runs, oldest, 'events.jsonl')), false);
  assert.equal(fs.existsSync(path.join(runs, oldest, 'events.jsonl.stderr')), false);
  assert.ok(fs.existsSync(path.join(runs, oldest, 'request.json')), 'the run record outlives its raw stream');
  assert.ok(fs.existsSync(path.join(runs, middle, 'events.jsonl')));
  assert.ok(fs.existsSync(path.join(runs, current, 'events.jsonl')));

  // The run that is starting is never the one removed, even when its stream is the oldest.
  assert.deepEqual(pruneRunLogs(dir, middle, 0), [path.join(runs, current, 'events.jsonl')]);
  assert.ok(fs.existsSync(path.join(runs, middle, 'events.jsonl')));
  assert.ok(fs.existsSync(path.join(dir, 'state.json')), 'state outside runs/ is never a candidate');
  assert.ok(fs.existsSync(path.join(dir, 'reports', 'run-result.json')), 'reports outside runs/ are never candidates');

  // The protected run keeps its stderr companion: the live runtime still writes there.
  const launch = '44444444-4444-4444-8444-444444444444';
  fs.mkdirSync(path.join(runs, launch), { recursive: true });
  fs.writeFileSync(path.join(runs, launch, 'events.jsonl'), 'x'.repeat(300));
  fs.writeFileSync(path.join(runs, launch, 'events.jsonl.stderr'), 'e');
  fs.utimesSync(path.join(runs, launch, 'events.jsonl'), 0, 0);
  assert.deepEqual(pruneRunLogs(dir, middle, 400, launch), [path.join(runs, launch, 'events.jsonl')]);
  assert.equal(fs.existsSync(path.join(runs, launch, 'events.jsonl')), false);
  assert.ok(fs.existsSync(path.join(runs, launch, 'events.jsonl.stderr')), 'the live stderr target survives pruning');
});

test('rotating a stream that reported backpressure still releases the paused source', async () => {
  const dir = tempDir('log-rotate-pressure');
  const writer = new LogWriter(path.join(dir, 'a.jsonl'), () => {});
  assert.equal(writer.stream.write('x'.repeat(1 << 20)), false, 'the chunk must exceed the stream high-water mark');
  const released = new Promise(resolve => writer.stream.once('drain', () => resolve(true)));
  writer.rotate(path.join(dir, 'b.jsonl'));
  const bounded = await Promise.race([released, new Promise(resolve => setTimeout(() => resolve(false), 2000))]);
  assert.equal(bounded, true, 'a rotated stream must still release a source paused on its backpressure');
  writer.end();
});

test('pruning skips symlinked streams, foreign names and a missing runs directory', () => {
  const dir = tempDir('log-prune-guards'), runs = path.join(dir, 'runs');
  fs.mkdirSync(runs, { recursive: true });
  const current = '33333333-3333-4333-8333-333333333333', linked = '44444444-4444-4444-8444-444444444444';
  const target = path.join(dir, 'outside.jsonl');
  fs.writeFileSync(target, 'y'.repeat(4096));
  fs.mkdirSync(path.join(runs, linked), { recursive: true });
  let symlinked = true;
  try { fs.symlinkSync(target, path.join(runs, linked, 'events.jsonl')); }
  catch { symlinked = false; }
  fs.mkdirSync(path.join(runs, 'not-a-run-id'), { recursive: true });
  fs.writeFileSync(path.join(runs, 'not-a-run-id', 'events.jsonl'), 'z'.repeat(4096));
  fs.mkdirSync(path.join(runs, current), { recursive: true });
  fs.writeFileSync(path.join(runs, current, 'events.jsonl'), 'x'.repeat(64));
  assert.deepEqual(pruneRunLogs(dir, current, 0), [], 'only real, named run streams are candidates');
  assert.equal(fs.existsSync(target), true, 'a symlinked target must survive');
  assert.equal(fs.existsSync(path.join(runs, 'not-a-run-id', 'events.jsonl')), true);
  if (symlinked) assert.equal(fs.existsSync(path.join(runs, linked, 'events.jsonl')), true, 'a symlinked stream is left alone');
  assert.deepEqual(pruneRunLogs(path.join(dir, 'absent'), current, 0), [], 'a missing runs directory is not an error');
});
