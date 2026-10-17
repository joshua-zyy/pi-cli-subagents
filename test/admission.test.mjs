// The admission contract: two caps (concurrent turns and resident runtimes), and a reservation that
// only the disk can retire once the run it reserved for is visible.
import test from 'node:test';
import assert from 'node:assert/strict';
import { countsAsActive, occupiesRuntime, pruneVisibleReservations, resolveCaps } from '../dist/manager.js';

/** Reservation keys are opaque; a NUL separator keeps them readable in a failure message. */
const key = (...parts) => parts.join('\u0000');

test('a managed runtime occupies its slot until the release is confirmed', () => {
  for (const phase of ['starting', 'running', 'waiting', 'stopping', 'idle', 'completed', 'failed', 'stopped']) {
    assert.equal(occupiesRuntime({ phase }), true, `${phase} still owns a runtime`);
  }
  assert.equal(occupiesRuntime({ phase: 'closed', runtimeClosed: true }), false, 'only a confirmed release returns the slot');
  assert.equal(occupiesRuntime({ phase: 'closed' }), true, 'a closed record without the runtime flag is not a confirmed release');
  assert.equal(occupiesRuntime({ phase: 'closed', runtimeClosed: false }), true);
  assert.equal(occupiesRuntime({ phase: 'unreachable' }), true, 'unknown ownership must not be counted as released');
});

test('only a step that may still execute takes a turn slot', () => {
  for (const phase of ['starting', 'running', 'waiting', 'stopping']) {
    assert.equal(countsAsActive({ phase }), true, `${phase} may still be executing`);
  }
  // `stopping` is set before the CLI is asked to stop, and unknown ownership may still write.
  assert.equal(countsAsActive({ phase: 'unreachable' }), true, 'unknown execution is not a free slot');
  for (const phase of ['idle', 'completed', 'failed', 'stopped', 'closed']) {
    assert.equal(countsAsActive({ phase }), false, `${phase} holds no turn`);
  }
});

test('a reservation survives until the run it reserved is visible', () => {
  const reservations = new Map([
    [key('root', 'a', '1'), { id: 'a' }],                    // new instance, no record yet
    [key('root', 'b', '2'), { id: 'b', priorRunId: 'r1' }],  // resident instance, old run only
    [key('root', 'c', '3'), { id: 'c', priorRunId: 'r1' }],  // resident instance, new run visible
    [key('other', 'e', '4'), { id: 'e' }],                   // another parent root
  ]);
  const views = [{ id: 'b', runId: 'r1' }, { id: 'c', runId: 'r2' }];
  assert.equal(pruneVisibleReservations(reservations, key('root', ''), views), 2,
    'the invisible new instance and the unchanged resident instance still count');
  assert.deepEqual([...reservations.keys()], [key('root', 'a', '1'), key('root', 'b', '2'), key('other', 'e', '4')],
    'only the reservation whose new run is visible is dropped; another root is untouched');
  // The instance is visible but still idle with its old run: a visible record alone must not retire it.
  // Only `a` (invisible new instance) and `b` (unchanged run) still count here.
  assert.equal(pruneVisibleReservations(reservations, key('root', ''), [{ id: 'b', runId: 'r1' }]), 2);
  assert.equal(pruneVisibleReservations(reservations, key('root', ''), [{ id: 'b', runId: 'r7' }]), 1);
});

test('the caps resolve from the environment with documented defaults', () => {
  assert.deepEqual(resolveCaps({}), { active: 4, resident: 12 }, 'defaults apply when nothing is configured');
  assert.deepEqual(resolveCaps({ PI_CLI_SUBAGENTS_MAX_ACTIVE: '0' }), { active: undefined, resident: 12 },
    '0 disables only that dimension');
  assert.deepEqual(resolveCaps({ PI_CLI_SUBAGENTS_MAX_ACTIVE: '0', PI_CLI_SUBAGENTS_MAX_RESIDENT: '0' }),
    { active: undefined, resident: undefined }, 'both dimensions need their own 0');
  assert.deepEqual(resolveCaps({ PI_CLI_SUBAGENTS_MAX_ACTIVE: '2' }), { active: 2, resident: 12 });
  assert.deepEqual(resolveCaps({ PI_CLI_SUBAGENTS_MAX_RUNTIMES: '3' }), { active: 4, resident: 3 },
    'the old variable still sets the resident cap');
  assert.deepEqual(resolveCaps({ PI_CLI_SUBAGENTS_MAX_RUNTIMES: '0' }), { active: 4, resident: undefined },
    'the old variable now accepts 0, which it used to reject');
});

test('the caps refuse ambiguous or invalid configuration', () => {
  assert.throws(() => resolveCaps({ PI_CLI_SUBAGENTS_MAX_RUNTIMES: '2', PI_CLI_SUBAGENTS_MAX_RESIDENT: '2' }), /both set the resident cap/i);
  for (const bad of ['', '  ', '-1', 'abc', '1.5']) {
    assert.throws(() => resolveCaps({ PI_CLI_SUBAGENTS_MAX_ACTIVE: bad }), /non-negative integer/i, `MAX_ACTIVE=${JSON.stringify(bad)}`);
    assert.throws(() => resolveCaps({ PI_CLI_SUBAGENTS_MAX_RUNTIMES: bad }), /non-negative integer/i, `MAX_RUNTIMES=${JSON.stringify(bad)}`);
  }
});
