// Snapshot panel rendering, navigation and action routing without a manager.
import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import { AgentsPanel, PANEL_MAX_ROWS } from '../dist/ui/panel.js';
const theme = { fg: (_, text) => text, bold: text => text };
const keys = { up: '\u001b[A', down: '\u001b[B', left: '\u001b[D', enter: '\r', escape: '\u001b' };
const view = (over = {}) => ({
  id: 'a1', runId: 'r1', phase: 'running', workerPid: 1, accepted: true, questions: [],
  startedAt: 1000, updatedAt: 1000, role: 'worker', cwd: 'D:/work', task: 'Implement widget', logFile: 'events.jsonl', ...over,
});
function panel(agents, options = {}) {
  const actions = [];
  const instance = new AgentsPanel(agents, theme, action => actions.push(action), { now: 11000, ...options });
  return { instance, actions, render: (width = 100) => instance.render(width) };
}
const text = rows => rows.join('\n');

test('list shows counts, hints, selection and right-aligned statistics', () => {
  const { render } = panel([view(), view({ id: 'a2', phase: 'completed', task: 'Review changes', updatedAt: 5000 })]);
  const rows = render(100);
  assert.match(rows[0], /^Subagents \(2\)$/); assert.match(rows[1], /↑↓ select · enter details · esc close/);
  assert.match(rows[2], /^ {2}● ⠋ worker {2}Implement widget {2,}Running · 10\.0s$/);
  assert.match(rows[3], /^ {2}○ ✓ worker {2}Review changes {2,}Completed · 4\.0s$/);
  for (const row of rows) assert.ok(visibleWidth(row) <= 100);
  assert.match(text(panel([view({ task: undefined })]).render()), /No task summary/);
});
test('empty snapshots have an empty-state message and exit hint', () => {
  const rows = panel([]).render(40);
  assert.match(rows[0], /Subagents \(0\)/); assert.match(rows[1], /No subagents in this session/); assert.match(rows[2], /esc close/);
});
test('arrow navigation clamps selection and keeps it in the visible window', () => {
  const { instance, render } = panel([view({ id: 'a0' }), view({ id: 'a1' }), view({ id: 'a2' })], { maxRows: 2 });
  instance.handleInput(keys.up); assert.equal(instance.selection, 0);
  for (let i = 0; i < 3; i++) instance.handleInput(keys.down);
  assert.equal(instance.selection, 2); const rows = render(); assert.match(text(rows), /↑ 1 more/);
  assert.ok(!text(rows).includes('↓ 1 more')); assert.ok(rows.slice(2).some(row => row.includes('●'))); assert.equal(PANEL_MAX_ROWS, 8);
});
test('Enter opens details including task, result, log and session; Esc navigates back', () => {
  const { instance, actions, render } = panel([view({ sessionId: 'sid-1', text: 'OK complete', lastActivity: 'tool_execution_end: bash' })]);
  instance.handleInput(keys.enter); assert.equal(instance.mode, 'detail'); const rows = render(); const body = text(rows);
  assert.match(rows[0], /^Subagent worker · Running$/);
  for (const fragment of ['ID a1', 'Directory D:/work', 'Elapsed 10.0s', 'Session sid-1', 'Log events.jsonl', 'Task', 'Implement widget', 'Latest activity', 'tool_execution_end: bash', 'Result', 'OK complete', 's message', 'v conversation']) assert.ok(body.includes(fragment), `Missing ${fragment}`);
  instance.handleInput(keys.escape); assert.equal(instance.mode, 'list');
  instance.handleInput(keys.escape); assert.deepEqual(actions, [undefined]); assert.equal(instance.mode, 'list');
});
test('failed instances show errors; waiting instances show sanitized questions', () => {
  const failed = panel([view({ phase: 'failed', text: undefined, error: 'Child exited unexpectedly' })]);
  failed.instance.handleInput(keys.enter); const body = text(failed.render());
  assert.ok(body.includes('Error')); assert.ok(body.includes('Child exited unexpectedly')); assert.ok(!body.includes('No text response'));
  const waiting = panel([view({ phase: 'waiting', questions: [{ id: 'q1', method: 'select', title: '\u001b[33mAllow execution?\u001b[39m' }] })]);
  waiting.instance.handleInput(keys.enter); const question = text(waiting.render());
  assert.ok(question.includes('Waiting for a response')); assert.ok(question.includes('Allow execution?'));
  assert.ok(!question.includes('\u001b')); assert.ok(question.includes('/agent-reply a1 q1')); assert.ok(question.includes('r reply'));
});
test('s/x/r/v return the intended action exactly once', () => {
  for (const [phase, key, expected] of [
    ['running', 's', { kind: 'message', id: 'a1', resume: false }],
    ['completed', 's', { kind: 'message', id: 'a1', resume: true }],
    ['running', 'x', { kind: 'stop', id: 'a1' }],
    ['running', 'v', { kind: 'view', id: 'a1' }],
    ['waiting', 'r', { kind: 'reply', id: 'a1', questionId: 'q1' }],
  ]) {
    const p = panel([view({ phase, questions: [{ id: 'q1', method: 'confirm', title: 'Allow?' }] })]);
    p.instance.handleInput(keys.enter); p.instance.handleInput(key); assert.deepEqual(p.actions, [expected]);
    p.instance.handleInput('x'); p.instance.handleInput(keys.escape); assert.equal(p.actions.length, 1); assert.ok(p.render().length);
  }
  const p = panel([view()]); p.instance.handleInput(keys.enter); p.instance.handleInput('r'); assert.deepEqual(p.actions, []);
  p.instance.handleInput('q'); assert.deepEqual(p.actions, [undefined]);
});
test('long results scroll with remaining-line indicators', () => {
  const long = Array.from({ length: 20 }, (_, i) => `Line ${i}`).join('\n'); const p = panel([view({ text: long })]);
  p.instance.handleInput(keys.enter); assert.ok(text(p.render()).includes('↓ 12 lines below'));
  p.instance.handleInput(keys.down); const scrolled = text(p.render()); assert.ok(scrolled.includes('↑ 1 lines above')); assert.ok(scrolled.includes('↓ 11 lines below'));
  p.instance.handleInput(keys.up); p.instance.handleInput(keys.up); assert.ok(!text(p.render()).includes('lines above'));
});
test('rendering is stable and width-bounded; Kitty-encoded keys route actions', () => {
  const p = panel([view({ task: '\u4efb\u52a1'.repeat(30), text: 'Result '.repeat(60) })]);
  const first = p.render(40); assert.deepEqual(p.render(40), first); assert.ok(first.every(row => visibleWidth(row) <= 40));
  assert.ok(p.render(0).some(row => visibleWidth(row) > 40));
  p.instance.handleInput(keys.enter); assert.equal(p.instance.mode, 'detail'); p.instance.handleInput('\u001b[115u'); assert.equal(p.actions.length, 1);
  const other = panel([view()]); other.instance.handleInput(keys.enter); other.instance.handleInput(keys.left); assert.equal(other.instance.mode, 'list');
});
test('waiting instances cannot be messaged and terminal instances cannot be stopped', () => {
  const waiting = panel([view({ phase: 'waiting', questions: [{ id: 'q1', method: 'confirm', title: 'Allow?' }] })]);
  waiting.instance.handleInput(keys.enter); const body = text(waiting.render()); assert.ok(body.includes('r reply')); assert.ok(!body.includes('s message'));
  waiting.instance.handleInput('s'); assert.deepEqual(waiting.actions, []);
  const finished = panel([view({ phase: 'completed', updatedAt: 5000 })]); finished.instance.handleInput(keys.enter);
  assert.ok(text(finished.render()).includes('s resume')); assert.ok(!text(finished.render()).includes('x stop'));
  finished.instance.handleInput('x'); assert.deepEqual(finished.actions, []);
});
test('detail results fit a 24-row terminal with keyboard hints visible', () => {
  const long = Array.from({ length: 40 }, (_, i) => `Line ${i}`).join('\n');
  const unbounded = panel([view({ text: long })]); unbounded.instance.handleInput(keys.enter); assert.ok(unbounded.render().length > 24);
  const bounded = panel([view({ text: long })], { rows: 24 }); bounded.instance.handleInput(keys.enter); const rows = bounded.render();
  assert.ok(rows.length <= 24, `Used ${rows.length} rows`); assert.ok(text(rows).includes('q close')); assert.ok(text(rows).includes('lines below'));
});

test('summary resizes without hiding action hints and preserves errors alongside partial text', () => {
  let height = 35;
  const p = panel([view({ phase: 'waiting', text: 'partial result', error: 'runtime failure', task: 'long task '.repeat(80), questions: [{ id: 'q', method: 'confirm', title: 'long question '.repeat(80) }] })], { rows: () => height });
  p.instance.handleInput(keys.enter);
  assert.match(text(p.render()), /runtime failure/);
  for (height of [20, 12, 6]) {
    const rows = p.render(70);
    assert.ok(rows.length <= height); assert.match(text(rows), /v conversation/);
    assert.match(text(rows), /q close/);
    assert.match(text(rows), /long question/);
    assert.match(text(rows), /\/agent-reply/);
  }
});
