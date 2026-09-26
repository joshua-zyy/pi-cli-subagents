import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import { ConversationViewer } from '../dist/ui/conversation.js';

const theme = { fg: (_, text) => text, bold: text => text };
const entry = (i, extra = {}) => ({ id: String(i), kind: 'assistant', title: 'Assistant', text: `Message ${i}`, ...extra });
const state = { id: 'agent-1', role: 'worker', phase: 'running', runId: 'run-1' };
const wait = ms => new Promise(r => setTimeout(r, ms));
function harness(load) {
  const actions = []; let renders = 0;
  const tui = { terminal: { rows: 14, columns: 70 }, requestRender() { renders++; } };
  const viewer = new ConversationViewer(tui, theme, action => actions.push(action), load, { intervalMs: 10 });
  return { viewer, actions, tui, get renders() { return renders; }, text: () => viewer.render(tui.terminal.columns).join('\n') };
}

test('viewer follows new events, pauses when scrolling, resumes with End, and stops polling on close', async t => {
  let entries = Array.from({ length: 30 }, (_, i) => entry(i)); let calls = 0;
  const h = harness(async () => { calls++; return { agent: state, entries, loading: false }; });
  t.after(() => h.viewer.dispose());
  await wait(25);
  assert.match(h.text(), /Message 29/);
  h.viewer.handleInput('\u001b[H'); // Home
  const top = h.text(); assert.match(top, /Message 0/); assert.match(top, /Paused/);
  entries = [...entries, entry(30)]; await wait(25);
  assert.match(h.text(), /Message 0/); assert.doesNotMatch(h.text(), /Message 30/);
  h.viewer.handleInput('\u001b[F'); // End
  assert.match(h.text(), /Message 30/); assert.match(h.text(), /Following/);
  h.viewer.handleInput('q');
  const stopped = calls, renders = h.renders;
  await wait(35); assert.equal(calls, stopped); assert.equal(h.renders, renders); assert.deepEqual(h.actions, [undefined]);
  h.viewer.handleInput('s'); assert.equal(h.actions.length, 1);
});

test('viewer renders tool inputs, multiline output, errors and resize without terminal control injection', async t => {
  const entries = [entry(1, { kind: 'tool', title: 'bash', input: '{"command":"npm test"}', text: '\u001b[31mfailed\u001b[0m\nsecond line', status: 'error' })];
  const h = harness(async () => ({ agent: state, entries, loading: false })); t.after(() => h.viewer.dispose());
  await wait(20);
  assert.match(h.text(), /npm test/); assert.match(h.text(), /failed/); assert.match(h.text(), /error/); assert.doesNotMatch(h.text(), /\u001b\[31m|\u0007|\u001b\]/); // Theme/layout reset codes are safe; source escape sequences are not.
  for (const rows of [6, 10, 24]) for (const columns of [10, 35, 80]) {
    h.tui.terminal.rows = rows; const rendered = h.viewer.render(columns);
    assert.ok(rendered.length <= rows); assert.ok(rendered.every(row => visibleWidth(row) <= columns));
  }
});

test('viewer errors stay visible and an in-flight read cannot redraw after disposal', async () => {
  const h = harness(async () => { throw Error('log unavailable'); });
  await wait(20); assert.match(h.text(), /log unavailable/); h.viewer.dispose();
  let resolve;
  const pending = harness(() => new Promise(r => { resolve = r; }));
  pending.viewer.dispose(); const renders = pending.renders;
  resolve({ agent: state, entries: [entry(1)], loading: false });
  await wait(20); assert.equal(pending.renders, renders);
});

test('page, half-line and configured scroll bindings all move the transcript and report position', async t => {
  const entries = Array.from({length:60},(_,i)=>entry(i,{text:`Message ${i}`}));
  const tui={terminal:{rows:20,columns:80},requestRender(){}};
  // A user-configured binding must win over the built-in default.
  const keybindings={matches:(data,action)=>action==='tui.altScreen.pageDown'&&data==='\u0006'};
  const viewer=new ConversationViewer(tui,theme,()=>{},async()=>({agent:state,entries,loading:false}),{intervalMs:10,keybindings});
  t.after(()=>viewer.dispose());
  await wait(40);
  const text=()=>viewer.render(80).join('\n');
  const percent=()=>Number(/(\d+)%/.exec(text())?.[1]);
  assert.match(text(),/Following · 120 lines · 100%/);
  assert.match(text(),/^╭─+╮$/m); assert.match(text(),/^╰─+╯$/m);
  viewer.handleInput('\u001b[H'); assert.match(text(),/Paused/);
  const top=percent(); assert.match(text(),/Message 0/);
  viewer.handleInput('\u001b[6~'); const onePage=percent(); assert.ok(onePage>top,'PageDown must advance'); assert.equal(onePage-top,Math.round((12/120)*100));
  viewer.handleInput('\u0006'); const configured=percent(); assert.ok(configured>onePage,'a configured binding must advance');
  viewer.handleInput('\u001b[1;2A'); const lineUp=percent(); assert.ok(lineUp<configured,'Shift+Up must scroll one line back');
  viewer.handleInput('\u001b[1;2B'); assert.ok(percent()>lineUp,'Shift+Down scrolls one line forward');
  const afterLine=percent();
  viewer.handleInput('\u001b[5~'); assert.ok(percent()<afterLine,'PageUp must return toward the start');
  viewer.handleInput('\u001b[F'); assert.match(text(),/Following · 120 lines · 100%/); assert.match(text(),/Message 59/);
  assert.ok(viewer.render(80).every(line=>visibleWidth(line)<=80));
});


test('a loading snapshot followed by failure uses the normal retry interval', async t => {
  let calls = 0;
  const tui = { terminal: { rows: 20, columns: 80 }, requestRender() {} };
  const viewer = new ConversationViewer(tui, theme, () => {}, async () => {
    if (++calls === 1) return { agent: state, entries: [], loading: true };
    throw Error('read failed');
  }, { intervalMs: 1000 });
  t.after(() => viewer.dispose());
  await wait(80);
  assert.equal(calls, 2, 'a stale loading=true snapshot must not cause immediate retries');
  assert.match(viewer.render(80).join('\n'), /read failed/);
});
