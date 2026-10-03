import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import { ConversationViewer } from '../dist/ui/conversation.js';

const theme = { fg: (_, text) => text, bold: text => text };
const markdownTheme = { heading: t => t, link: t => t, linkUrl: t => t, code: t => t, codeBlock: t => t, codeBlockBorder: t => t, quote: t => t, quoteBorder: t => t, hr: t => t, listBullet: t => t, bold: t => t, italic: t => t, strikethrough: t => t, underline: t => t };
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
  h.tui.terminal.rows = 20; // Keep the tool header and expanded details visible together.
  h.viewer.handleInput('\x0f'); // Inspect expanded tool details.
  assert.match(h.text(), /npm test/); assert.match(h.text(), /failed/); assert.match(h.text(), /error/); assert.doesNotMatch(h.text(), /\u001b\[31m|\u0007|\u001b\]/); // Theme/layout reset codes are safe; source escape sequences are not.
  for (const rows of [6, 10, 24]) for (const columns of [10, 35, 80]) {
    h.tui.terminal.rows = rows; const rendered = h.viewer.render(columns);
    assert.ok(rendered.length <= rows); assert.ok(rendered.every(row => visibleWidth(row) <= columns));
  }
});

test('long tool output wraps without repeatedly copying large prefixes', async t => {
  const text = 'BEGIN' + 'x'.repeat(8000) + 'END';
  const h = harness(async () => ({ agent: state, entries: [entry(1, { kind: 'tool', title: 'bash', text, status: 'done' })], loading: false }));
  t.after(() => h.viewer.dispose());
  await new Promise(setImmediate);
  h.viewer.handleInput('\x0f');
  // Count substring work during this synchronous render, not load-dependent wall time.
  const original = String.prototype.slice;
  let copied = 0, rendered;
  try {
    String.prototype.slice = function (...args) {
      const result = original.apply(this, args); copied += result.length; return result;
    };
    rendered = h.viewer.render(100);
  } finally { String.prototype.slice = original; }
  assert.ok(copied < text.length * 128, `Rendered ${text.length} characters with ${copied} characters of substring work`);
  assert.match(rendered.join('\n'), /END/);
  h.viewer.handleInput('\u001b[H');
  assert.match(h.viewer.render(100).join('\n'), /BEGIN/, 'fast wrapping must not discard earlier output');
});

test('hard-wrapped tool output preserves whitespace and whole graphemes at narrow widths', async () => {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const text of ['   alpha  beta    gamma   ', '\t  indented\tvalue \tend   ', 'x👨‍👩‍👧‍👦e\u0301🇨🇳中z', '  first\n\nlast  ']) {
    const expected = text.replace(/\n/g, '');
    const boundaries = new Set([0]);
    for (const { index, segment } of segmenter.segment(expected)) boundaries.add(index + segment.length);
    for (const columns of [8, 9, 12, 20, 80]) {
      const wrapped = [];
      const capture = { ...theme, fg: (color, value) => { if (color === 'toolOutput') wrapped.push(value); return value; } };
      const tui = { terminal: { rows: 40, columns }, requestRender() {} };
      const viewer = new ConversationViewer(tui, capture, () => {}, async () => ({ agent: state,
        entries: [entry(1, { kind: 'tool', title: 'bash', text, status: 'done' })], loading: false }));
      try {
        await new Promise(setImmediate);
        viewer.handleInput('\x0f');
        const rendered = viewer.render(columns);
        assert.equal(wrapped.join(''), expected, `whitespace/content at width ${columns}`);
        if (text.includes('\n\n')) assert.ok(wrapped.includes(''), 'explicit empty lines are retained');
        let offset = 0;
        for (const line of wrapped) {
          offset += line.length;
          assert.ok(boundaries.has(offset), `split grapheme at offset ${offset}, width ${columns}`);
          if (visibleWidth(line) > Math.max(1, columns - 8)) {
            assert.equal([...segmenter.segment(line)].length, 1, 'an oversized grapheme stays whole on its own line');
          }
        }
        assert.ok(rendered.every(line => visibleWidth(line) <= columns));
      } finally { viewer.dispose(); }
    }
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
  // Header, body and footer all live inside the same border, so no row spills past it.
  const rows = viewer.render(80);
  for (const [index, line] of rows.entries()) {
    assert.equal(visibleWidth(line), 80, `row ${index} must fill the frame`);
    if (index === 0) assert.match(line, /^╭─+╮$/);
    else if (index === rows.length - 1) assert.match(line, /^╰─+╯$/);
    else if (!/^├─+┤$/.test(line)) assert.match(line, /^│.*│$/, `row ${index} must be framed`);
  }
  assert.match(rows.join('\n'), /│ Following · 120 lines · 100%/);
});


test('viewer shows lifetime tokens and the child model, and sends inline without closing', async t => {
  const sent = [];
  const tui = { terminal: { rows: 20, columns: 80 }, requestRender() {} };
  const snapshot = { agent: state, entries: [entry(1, { text: 'Handling it' })], loading: false, usage: { input: 150, output: 25, cacheRead: 900, cacheWrite: 10, cost: 0, contextTokens: 1085 }, provider: 'opencode-go', model: 'deepseek-v4.1-flash' };
  const viewer = new ConversationViewer(tui, theme, () => {}, async () => snapshot, { intervalMs: 10, markdownTheme, onSend: async (message) => { sent.push(message); } });
  t.after(() => viewer.dispose());
  await wait(30);
  assert.match(viewer.render(80).join('\n'), /1\.1k tokens · deepseek-v4\.1-flash/);
  assert.match(viewer.render(80).join('\n'), /Enter message/);
  viewer.handleInput('\r');
  const open = viewer.render(80).join('\n');
  assert.match(open, /✎ message/); assert.match(open, /Enter send · Esc cancel/);
  for (const key of ['h', 'i']) viewer.handleInput(key);
  assert.deepEqual(sent, [], 'typing must not send or scroll');
  viewer.handleInput('\u001b'); // Esc cancels the composer
  assert.doesNotMatch(viewer.render(80).join('\n'), /✎ message/);
  viewer.handleInput('\r'); viewer.handleInput('p'); viewer.handleInput('\r');
  assert.deepEqual(sent, ['p']);
  await wait(20);
  assert.match(viewer.render(80).join('\n'), /Message accepted/);
  assert.ok(viewer.render(80).every(line => visibleWidth(line) <= 80));
});

test('the composer is unavailable for a read-only child and reports send failures', async t => {
  const tui = { terminal: { rows: 16, columns: 60 }, requestRender() {} };
  const blocked = { agent: { ...state, phase: 'unreachable' }, entries: [entry(1)], loading: false };
  const viewer = new ConversationViewer(tui, theme, () => {}, async () => blocked, { intervalMs: 10, onSend: async () => { throw Error('worker has exited'); } });
  t.after(() => viewer.dispose());
  await wait(20);
  assert.doesNotMatch(viewer.render(60).join('\n'), /Enter message|Enter resume/);
  viewer.handleInput('\r');
  assert.doesNotMatch(viewer.render(60).join('\n'), /✎ message/, 'a non-resumable child gets no composer');
  const resumable = new ConversationViewer(tui, theme, () => {}, async () => ({ agent: { ...state, phase: 'completed' }, entries: [entry(1)], loading: false }), { intervalMs: 10, onSend: async () => { throw Error('worker has exited'); } });
  t.after(() => resumable.dispose());
  await wait(20);
  assert.match(resumable.render(60).join('\n'), /Enter resume/);
  resumable.handleInput('\r'); resumable.handleInput('x'); resumable.handleInput('\r');
  await wait(20);
  assert.match(resumable.render(60).join('\n'), /Send failed: worker has exited/);
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
