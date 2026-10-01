// Snapshot pane rendering, navigation and action routing without a manager.
import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import { AgentsPanel, PANEL_MAX_ROWS, paneRows } from '../dist/ui/panel.js';
const theme = { fg: (_, text) => text, bold: text => text };
const keys = { up: '\u001b[A', down: '\u001b[B', left: '\u001b[D', enter: '\r', escape: '\u001b' };
const view = (over = {}) => ({
  id: 'a1', runId: 'r1', phase: 'running', workerPid: 1, accepted: true, questions: [],
  startedAt: 1000, updatedAt: 1000, role: 'worker', cwd: 'D:/work', task: 'Implement widget', logFile: 'events.jsonl', ...over,
});
/** The roster is a framed pane; these tests read its body without the border and its padding. */
const body = (rows) => rows.slice(1, -1).map((row) => row.slice(2).replace(/ +│$/, ''));
function panel(agents, options = {}) {
  const actions = [];
  const instance = new AgentsPanel(agents, theme, action => actions.push(action), { now: 11000, ...options });
  return { instance, actions, framed: (width = 100) => instance.render(width), render: (width = 100) => body(instance.render(width)) };
}
const text = rows => rows.join('\n');

test('the pane is framed like the role editor, in every view', () => {
  const p = panel([view()]);
  for (const rows of [p.framed(100), p.framed(40)]) {
    assert.match(rows[0], /^╭─+╮$/); assert.match(rows.at(-1), /^╰─+╯$/);
    for (const row of rows) assert.ok(visibleWidth(row) === visibleWidth(rows[0]), 'every line is padded to the frame');
  }
  // Painted with the host's editor border, so it reads as part of the input area.
  const painted = new AgentsPanel([view()], theme, () => {}, { frameColor: text => `<${text}>` }).render(40);
  assert.match(painted[0], /^<╭─+╮>$/); assert.match(painted[1], /^<│> /);
});

test('pane height stays compact for the roster and grows for the result it has to show', () => {
  assert.equal(paneRows(120, 'list'), PANEL_MAX_ROWS + 4, 'the roster is capped like the role editor');
  assert.equal(paneRows(35, 'list'), 11, 'a third of a 35-row terminal');
  assert.ok(paneRows(35, 'detail') > paneRows(35, 'list'), 'the detail view needs room for a result');
  assert.ok(paneRows(8, 'list') > 0 && paneRows(8, 'detail') > 0, 'a short terminal still gets a pane');
  assert.equal(paneRows(Number.NaN, 'list'), paneRows(24, 'list'));
});

test('list shows counts, hints, selection and right-aligned statistics', () => {
  const { render } = panel([view(), view({ id: 'a2', phase: 'completed', task: 'Review changes', updatedAt: 5000 })]);
  const rows = render(100);
  assert.match(rows[0], /^Subagents \(2\)$/); assert.match(rows[1], /↑↓ select · enter\/v conversation · i details · esc close/);
  assert.match(rows[2], /^ {2}› ⠋ worker a1 {2}Implement widget {2,}Running · 10\.0s$/);
  assert.match(rows[3], /^ {4}✓ worker a2 {2}Review changes {2,}Completed · 4\.0s$/);
  for (const row of panel([view()]).framed(100)) assert.ok(visibleWidth(row) <= 100);
  assert.match(text(panel([view({ task: undefined })]).render()), /No task summary/);
});
test('same-role instances stay distinguishable when the task summary no longer fits', () => {
  const rows = panel([
    view({ id: '3f2a9c1b-1111-4111-8111-111111111111', task: 'Add multiplication to the calculator module' }),
    view({ id: 'b7e4d2a0-2222-4222-8222-222222222222', task: 'Add addition to the calculator module' }),
  ]).render(44);
  assert.match(rows[2], /worker 3f2a9c1b/); assert.match(rows[3], /worker b7e4d2a0/);
  assert.notEqual(rows[2], rows[3], 'identical roles must not render identical rows');
  for (const row of rows) assert.ok(visibleWidth(row) <= 44);
  // The full identifier stays available where there is room to act on it.
  const detail = panel([view({ id: '3f2a9c1b-1111-4111-8111-111111111111' })]);
  detail.instance.handleInput('i');
  assert.match(text(detail.render(80)), /ID 3f2a9c1b-1111-4111-8111-111111111111/);
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
  assert.ok(!text(rows).includes('↓ 1 more')); assert.ok(rows.slice(2).some(row => row.includes('›'))); assert.equal(PANEL_MAX_ROWS, 8);
});
test('i opens details including task, result, log and session; Esc navigates back', () => {
  const { instance, actions, render } = panel([view({ sessionId: 'sid-1', text: 'OK complete', lastActivity: 'tool_execution_end: bash' })]);
  instance.handleInput('i'); assert.equal(instance.mode, 'detail'); const rows = render(); const body = text(rows);
  assert.match(rows[0], /^Subagent worker · Running$/);
  for (const fragment of ['ID a1', 'Directory D:/work', 'Elapsed 10.0s', 'Session sid-1', 'Log events.jsonl', 'Task', 'Implement widget', 'Latest activity', 'tool_execution_end: bash', 'Result', 'OK complete', 's message', 'v conversation']) assert.ok(body.includes(fragment), `Missing ${fragment}`);
  instance.handleInput(keys.escape); assert.equal(instance.mode, 'list');
  instance.handleInput(keys.escape); assert.deepEqual(actions, [undefined]); assert.equal(instance.mode, 'list');
});
test('failed instances show errors; waiting instances show sanitized questions', () => {
  const failed = panel([view({ phase: 'failed', text: undefined, error: 'Child exited unexpectedly' })]);
  failed.instance.handleInput('i'); const body = text(failed.render());
  assert.ok(body.includes('Error')); assert.ok(body.includes('Child exited unexpectedly')); assert.ok(!body.includes('No text response'));
  const waiting = panel([view({ phase: 'waiting', questions: [{ id: 'q1', method: 'select', title: '\u001b[33mAllow execution?\u001b[39m' }] })]);
  waiting.instance.handleInput('i'); const question = text(waiting.render());
  assert.ok(question.includes('Waiting for a response')); assert.ok(question.includes('Allow execution?'));
  assert.ok(!question.includes('\u001b')); assert.ok(question.includes('r reply'));
  // One request is answered with r; quoting IDs here only suggests they must be typed by hand.
  assert.ok(!question.includes('/agent-reply'), 'a single request must not ask for its ID');
  assert.ok(!question.includes('requests pending'));
});
test('a queue of requests is announced without asking the human for IDs', () => {
  const p = panel([view({ phase: 'waiting', questions: [{ id: 'q1', method: 'confirm', title: 'Allow?' }, { id: 'q2', method: 'confirm', title: 'Allow again?' }] })]);
  p.instance.handleInput('i'); const body = text(p.render());
  assert.match(body, /2 requests pending; r answers them one at a time/);
  assert.ok(!body.includes('/agent-reply'), 'the panel answers the request on screen; IDs stay an escape hatch');
  assert.match(body, /Allow\?/);
});
test('the list opens any child conversation directly without first opening details', () => {
  const p=panel([view({id:'a1'}),view({id:'a2'})]);
  p.instance.handleInput(keys.down);p.instance.handleInput(keys.enter);
  assert.deepEqual(p.actions,[{kind:'view',id:'a2'}]);
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
    p.instance.handleInput('i'); p.instance.handleInput(key); assert.deepEqual(p.actions, [expected]);
    p.instance.handleInput('x'); p.instance.handleInput(keys.escape); assert.equal(p.actions.length, 1); assert.ok(p.render().length);
  }
  const p = panel([view()]); p.instance.handleInput('i'); p.instance.handleInput('r'); assert.deepEqual(p.actions, []);
  p.instance.handleInput('q'); assert.deepEqual(p.actions, [undefined]);
});
test('long results scroll with remaining-line indicators', () => {
  const long = Array.from({ length: 20 }, (_, i) => `Line ${i}`).join('\n'); const p = panel([view({ text: long })]);
  p.instance.handleInput('i'); assert.ok(text(p.render()).includes('↓ 12 lines below'));
  p.instance.handleInput(keys.down); const scrolled = text(p.render()); assert.ok(scrolled.includes('↑ 1 lines above')); assert.ok(scrolled.includes('↓ 11 lines below'));
  p.instance.handleInput(keys.up); p.instance.handleInput(keys.up); assert.ok(!text(p.render()).includes('lines above'));
});
test('rendering is stable and width-bounded; Kitty-encoded keys route actions', () => {
  const p = panel([view({ task: '\u4efb\u52a1'.repeat(30), text: 'Result '.repeat(60) })]);
  const first = p.render(40); assert.deepEqual(p.render(40), first); assert.ok(first.every(row => visibleWidth(row) <= 40));
  assert.ok(p.render(0).some(row => visibleWidth(row) > 40));
  p.instance.handleInput('i'); assert.equal(p.instance.mode, 'detail'); p.instance.handleInput('\u001b[115u'); assert.equal(p.actions.length, 1);
  const other = panel([view()]); other.instance.handleInput('i'); other.instance.handleInput(keys.left); assert.equal(other.instance.mode, 'list');
});
test('waiting instances cannot be messaged and terminal instances cannot be stopped', () => {
  const waiting = panel([view({ phase: 'waiting', questions: [{ id: 'q1', method: 'confirm', title: 'Allow?' }] })]);
  waiting.instance.handleInput('i'); const body = text(waiting.render()); assert.ok(body.includes('r reply')); assert.ok(!body.includes('s message'));
  waiting.instance.handleInput('s'); assert.deepEqual(waiting.actions, []);
  const finished = panel([view({ phase: 'completed', updatedAt: 5000 })]); finished.instance.handleInput('i');
  assert.ok(text(finished.render()).includes('s resume')); assert.ok(!text(finished.render()).includes('x stop'));
  finished.instance.handleInput('x'); assert.deepEqual(finished.actions, []);
});
test('detail results fit a 24-row terminal with keyboard hints visible', () => {
  const long = Array.from({ length: 40 }, (_, i) => `Line ${i}`).join('\n');
  const unbounded = panel([view({ text: long })]); unbounded.instance.handleInput('i'); assert.ok(unbounded.render().length > 24);
  const bounded = panel([view({ text: long })], { rows: 24 }); bounded.instance.handleInput('i'); const rows = bounded.render();
  assert.ok(rows.length <= 24, `Used ${rows.length} rows`); assert.ok(text(rows).includes('q close')); assert.ok(text(rows).includes('lines below'));
});

test('summary resizes without hiding action hints and preserves errors alongside partial text', () => {
  let height = 35;
  const p = panel([view({ phase: 'waiting', text: 'partial result', error: 'runtime failure', task: 'long task '.repeat(80), questions: [{ id: 'q', method: 'confirm', title: 'long question '.repeat(80) }] })], { rows: () => height });
  p.instance.handleInput('i');
  assert.match(text(p.render()), /runtime failure/);
  // The pane takes rows of its own for the frame, so the body is bounded by the height minus two.
  for (const [size, roomy] of [[24, true], [16, true], [8, false]]) {
    height = size;
    const rows = p.render(70);
    assert.ok(rows.length + 2 <= size, `Used ${rows.length + 2} of ${size} rows`);
    assert.match(text(rows), /v conversation/);
    assert.match(text(rows), /q close/);
    if (roomy) { assert.match(text(rows), /long question/); assert.match(text(rows), /r reply/); }
  }
});
