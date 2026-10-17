// The admission contract: a slot returns only after a confirmed release.
import test from 'node:test';
import assert from 'node:assert/strict';
import { occupiesRuntime } from '../dist/manager.js';

test('a managed runtime occupies its slot until the release is confirmed', () => {
  for (const phase of ['starting', 'running', 'waiting', 'stopping', 'idle']) {
    assert.equal(occupiesRuntime({ phase }), true, `${phase} still owns a runtime`);
  }
  assert.equal(occupiesRuntime({ phase: 'closed', runtimeClosed: true }), false, 'only a confirmed release returns the slot');
  assert.equal(occupiesRuntime({ phase: 'closed' }), true, 'a closed record without the runtime flag is not a confirmed release');
  assert.equal(occupiesRuntime({ phase: 'closed', runtimeClosed: false }), true);
  assert.equal(occupiesRuntime({ phase: 'unreachable' }), true, 'unknown ownership must not be counted as released');
});
