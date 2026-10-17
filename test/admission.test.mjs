// The admission contract: a slot returns only after a confirmed release.
import test from 'node:test';
import assert from 'node:assert/strict';
import { occupiesRuntime, pruneVisibleReservations } from '../dist/manager.js';

test('a managed runtime occupies its slot until the release is confirmed', () => {
  for (const phase of ['starting', 'running', 'waiting', 'stopping', 'idle', 'completed', 'failed', 'stopped']) {
    assert.equal(occupiesRuntime({ phase }), true, `${phase} still owns a runtime`);
  }
  assert.equal(occupiesRuntime({ phase: 'closed', runtimeClosed: true }), false, 'only a confirmed release returns the slot');
  assert.equal(occupiesRuntime({ phase: 'closed' }), true, 'a closed record without the runtime flag is not a confirmed release');
  assert.equal(occupiesRuntime({ phase: 'closed', runtimeClosed: false }), true);
  assert.equal(occupiesRuntime({ phase: 'unreachable' }), true, 'unknown ownership must not be counted as released');
});

test('a reservation stops counting once its runtime is visible', () => {
  const reservations = new Set(['root\0a', 'root\0b', 'other\0c']);
  assert.equal(pruneVisibleReservations(reservations, 'root\0', ['a']), 1,
    'a visible runtime is counted from disk, so its reservation must go');
  assert.deepEqual([...reservations], ['root\0b', 'other\0c'],
    'only this root\'s visible id is dropped; other reservations and roots stay');
  assert.equal(pruneVisibleReservations(reservations, 'root\0', ['zzz']), 1,
    'a visible id that was never reserved changes nothing');
  assert.equal(pruneVisibleReservations(reservations, 'root\0', ['b']), 0, 'the last reservation is dropped once its runtime shows up');
});
