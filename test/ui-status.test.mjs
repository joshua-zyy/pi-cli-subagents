// Status rendering and widget lifecycle without a real terminal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { formatElapsed, formatTokens, oneLine, rightAlign, viewElapsed, canMessage } from '../dist/ui/format.js';
import { FINISHED_LINGER_MS, MAX_STATUS_LINES, STATUS_KEY, StatusWidget, statusLines } from '../dist/ui/status.js';

const theme = { fg: (_color, text) => text, bold: text => text };
const tagged = { fg: (color, text) => `[${color}]${text}`, bold: text => text };
const view = (over = {}) => ({
  id: 'a1', runId: 'r1', phase: 'running', workerPid: 1, accepted: true, questions: [],
  startedAt: 1000, updatedAt: 1000, role: 'worker', cwd: '/tmp', task: 'Implement UI', logFile: 'log.jsonl', ...over,
});
const lines = (agents, options = {}) => statusLines(agents, { now: 11000, frame: 0, width: 120, theme, ...options });

test('token counts stay compact and messageability excludes unreachable instances', () => {
  for (const [input, expected] of [[0, '0'], [512, '512'], [999, '999'], [1000, '1.0k'], [12345, '12.3k'], [1_234_567, '1.2M'], [-5, '0'], [NaN, '0']]) assert.equal(formatTokens(input), expected);
  for (const phase of ['starting', 'running', 'completed', 'failed', 'stopped']) assert.equal(canMessage(phase), true, phase);
  for (const phase of ['waiting', 'stopping', 'unreachable']) assert.equal(canMessage(phase), false, phase);
});

test('elapsed formatting handles all units and invalid inputs', () => {
  for (const [input, expected] of [[0, '0.0s'], [-500, '0.0s'], [420, '0.4s'], [12345, '12.3s'], [252000, '4m12s'], [3780000, '1h03m'], [NaN, '0.0s']]) assert.equal(formatElapsed(input), expected);
});
test('oneLine strips terminal sequences, collapses whitespace and clips', () => {
  assert.equal(oneLine('\u001b[33m⚠ Allow?\u001b[39m', 40), '⚠ Allow?');
  assert.equal(oneLine('  multiple\n  lines\ttext  ', 40), 'multiple lines text');
  assert.equal(oneLine(undefined, 40), ''); assert.equal(oneLine('abcdef', 3), 'abc');
});
test('terminal elapsed time freezes at updatedAt', () => {
  assert.equal(viewElapsed(view(), 11000), 10000);
  assert.equal(viewElapsed(view({ phase: 'completed', updatedAt: 5000 }), 11000), 4000);
  assert.equal(viewElapsed(view({ phase: 'completed', updatedAt: 5000 }), 99000), 4000);
});
test('active instances use two rows with a closing connector on the last entry', () => {
  const rows = lines([view({ lastActivity: 'tool_execution_start: bash' })]);
  assert.match(rows[0], /^● Subagents · 1 running · Ctrl\+Alt\+A view$/);
  assert.match(rows[1], /^└─ ⠋ worker {2}Implement UI +· Running · 10\.0s$/);
  assert.match(rows[2], /^ {3}⎿ tool_execution_start: bash$/);
  const pair = lines([view({ id: 'a1', task: 'First' }), view({ id: 'a2', startedAt: 2000, task: 'Second' })]);
  assert.match(pair[1], /^├─ ⠋ worker {2}First +· Running · 10\.0s$/);
  assert.match(pair[2], /^│ {4}⎿ /);
  assert.match(pair[3], /^└─ ⠋ worker {2}Second +· Running · 9\.0s$/);
  assert.match(pair[4], /^ {3}⎿ /);
});
test('narrow terminals retain status and elapsed time ahead of wide Unicode task text', () => {
  const task = '\u5b9e\u65bd\u4efb\u52a1'.repeat(20);
  const rows = lines([view({ task })], { width: 60 });
  assert.ok(rows.every(row => visibleWidth(row) <= 60)); assert.match(rows[1], /Running/); assert.match(rows[1], /10\.0s$/);
  const waiting = lines([view({ phase: 'waiting', task, questions: [{ id: 'q1', method: 'select', title: 'Human response needed' }] })], { width: 60 });
  assert.match(waiting[1], /Waiting/); assert.match(waiting[1], /10\.0s$/);
});
test('waiting entries have priority, warning color and sanitized titles', () => {
  const waiting = view({ phase: 'waiting', questions: [{ id: 'q1', method: 'select', title: '\u001b[33mAllow bash?\u001b[39m' }] });
  const rows = lines([waiting, view({ id: 'a2' })], { theme: tagged });
  assert.ok(!rows.join('\n').includes('\u001b'));
  assert.match(rows[1], /^\[dim\]├─ \[warning\]⚠ \[text\]worker {2}\[muted\]Implement UI +\[dim\]· Waiting · 10\.0s$/);
  assert.match(rows[2], /Allow bash\?/); assert.match(rows[0], /1 running · 1 waiting/);
});
test('finished entries collapse and disappear after their linger period', () => {
  const done = view({ phase: 'completed', updatedAt: 5000 });
  const rows = statusLines([done], { now: 5000 + FINISHED_LINGER_MS, frame: 0, width: 120, theme });
  assert.equal(rows.length, 2); assert.match(rows[1], /^└─ ✓ worker {2}Implement UI +· Completed · 4\.0s$/);
  assert.deepEqual(statusLines([done], { now: 5001 + FINISHED_LINGER_MS, frame: 0, width: 120, theme }), []);
  assert.deepEqual(lines([]), []);
});
test('errors stay inline and waiting entries do not expire', () => {
  const rows = lines([view({ phase: 'failed', error: 'Child exited unexpectedly', updatedAt: 5000 })]);
  assert.match(rows[1], /^└─ ✗ worker {2}Implement UI +· Failed: Child exited unexpectedly · 4\.0s$/);
  const stuck = view({ phase: 'waiting', updatedAt: 1000, questions: [{ id: 'q1', method: 'select', title: 'Human response needed' }] });
  assert.equal(statusLines([stuck], { now: 10 * FINISHED_LINGER_MS, frame: 0, width: 120, theme }).length, 3);
});
test('overflow retains waiting, active, then newest finished instances and counts correctly', () => {
  const agents = [view({ id: 'w', phase: 'waiting', questions: [{ id: 'q1', method: 'select', title: 'Respond' }] }),
    ...Array.from({ length: 12 }, (_, i) => view({ id: `a${i}`, startedAt: 1000 + i, task: `Task${i}` }))];
  const rows = lines(agents);
  assert.equal(rows.length, MAX_STATUS_LINES); assert.match(rows[0], /12 running · 1 waiting/);
  assert.ok(rows.some(row => row.includes('Task0'))); assert.equal(rows.at(-1), '+ 9 more (/agents)');
  const completed = Array.from({ length: 12 }, (_, i) => view({ id: `c${i}`, phase: 'completed', startedAt: 1000 + i * 10, updatedAt: 5000 + i * 10, task: `Done${i}` }));
  const kept = lines(completed);
  assert.match(kept[0], /12 ended/); assert.ok(kept.some(row => row.includes('Done11'))); assert.ok(!kept.some(row => row.includes('Done0')));
  assert.equal(kept.at(-1), '+ 4 more (/agents)');
});
test('rightAlign clips the left side first', () => {
  assert.equal(rightAlign('abcdefgh', '12.3s', 20), `abcdefgh${' '.repeat(6)} 12.3s`);
  const tight = rightAlign('abcdefgh', '12.3s', 12);
  assert.equal(visibleWidth(tight), 12); assert.match(stripTerminalSequences(tight), /^abc\.\.\. 12\.3s$/);
  assert.equal(visibleWidth(rightAlign('abcdefgh', '12.3s', 4)), 4);
  assert.equal(rightAlign('Task', 'Completed · 1.0s', 0), 'Task Completed · 1.0s');
});
function host() { const calls = []; return { calls, setWidget(key, content, options) { calls.push({ key, content, options }); } }; }
const ticker = () => { const state = { ticks: 0 }; const tui = { terminal: { columns: 100 }, requestRender() { state.ticks++; } }; return { state, tui }; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
test('empty widgets do not register; active widgets register once and request redraw', () => {
  const idle = host(); new StatusWidget(idle, () => []).update(); assert.equal(idle.calls.length, 0);
  const active = host(); const widget = new StatusWidget(active, () => [view()], { intervalMs: 10 });
  widget.update(); widget.update(); assert.equal(active.calls.length, 1); assert.equal(active.calls[0].key, STATUS_KEY);
  const { state, tui } = ticker(); const component = active.calls[0].content(tui, theme);
  assert.match(component.render(100).join('\n'), /worker/); widget.update(); assert.ok(state.ticks >= 1);
  widget.dispose(); assert.equal(active.calls.at(-1).content, undefined);
});
test('disposing stops timers and prevents further widget side effects', async () => {
  const active = host(); const widget = new StatusWidget(active, () => [view()], { intervalMs: 10 });
  widget.update(); const { state, tui } = ticker(); active.calls[0].content(tui, theme);
  await sleep(50); assert.ok(state.ticks >= 2); widget.dispose();
  const calls = active.calls.length, ticks = state.ticks;
  await sleep(30); assert.equal(active.calls.length, calls); assert.equal(state.ticks, ticks);
  widget.update(); assert.equal(active.calls.length, calls);
});
test('read failure preserves the last snapshot; old finished entries do not register', async () => {
  const active = host(); let fail = false;
  const widget = new StatusWidget(active, () => { if (fail) throw Error('Corrupt record'); return [view()]; }, { intervalMs: 10, lingerMs: 0 });
  widget.update(); const { tui } = ticker(); active.calls[0].content(tui, theme); fail = true;
  const saved = console.error; console.error = () => {};
  try { assert.doesNotThrow(() => widget.update()); } finally { console.error = saved; }
  assert.equal(active.calls.length, 1); await sleep(30); widget.dispose();
  const finished = host(); const old = new StatusWidget(finished, () => [view({ phase: 'completed', updatedAt: 1 })], { lingerMs: 0 });
  old.update(); assert.equal(finished.calls.length, 0); old.dispose();
});
