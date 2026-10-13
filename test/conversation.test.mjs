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
  assert.match(viewer.render(80).join('\n'), /without a delivery receipt/);
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
  let failedSends = 0;
  const resumable = new ConversationViewer(tui, theme, () => {}, async () => ({ agent: { ...state, phase: 'completed' }, entries: [entry(1)], loading: false }), { intervalMs: 10, onSend: async () => { failedSends++; throw Error('worker has exited'); } });
  t.after(() => resumable.dispose());
  await wait(20);
  assert.match(resumable.render(60).join('\n'), /Enter resume/);
  resumable.handleInput('\r'); resumable.handleInput('x'); resumable.handleInput('\r');
  await wait(20);
  assert.match(resumable.render(60).join('\n'), /Send failed: worker has exited/);
  assert.equal(failedSends, 1, 'the viewer must not retry a rejected host send');
});

test('multiline interaction notices occupy physical rows without escaping the viewer frame', async t => {
  const text = '\x1b[33mDangerous bash command\x1b[0m\r\n\r\nVerify the target and scope before allowing.\n命令: rm -rf /tmp/owned-probe\nOptions: Block | Allow once';
  const notice = entry(1, { kind: 'notice', title: 'Interaction request (select)', text });
  const h = harness(async () => ({ agent: state, entries: [notice], loading: false }));
  t.after(() => h.viewer.dispose());
  await new Promise(setImmediate);
  for (const rows of [14, 40]) for (const columns of [35, 80, 160]) {
    h.tui.terminal.rows = rows;
    h.tui.terminal.columns = columns;
    for (const key of ['\x1b[H', '\x1b[F']) {
      h.viewer.handleInput(key);
      const frame = h.viewer.render(columns);
      assert.ok(frame.length <= rows, 'the overlay stays within its allocated height');
      assert.ok(frame.every(row => !/[\r\n]/.test(row)), 'each rendered string must be one physical terminal row');
      assert.ok(frame.every(row => visibleWidth(row) <= columns), 'every row fits inside the frame');
    }
  }
  const frame = h.viewer.render(160);
  assert.match(frame.join('\n'), /Dangerous bash command/);
  assert.match(frame.join('\n'), /Options: Block \| Allow once/);
  assert.ok(frame.some(row => /^│\s+│$/.test(row)), 'explicit blank lines remain visible');
  assert.equal(notice.text, text, 'formatting never rewrites the original notice');
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

test('viewer offers t only for v2 Pi/Codex active runs, including while history loads', async () => {
  for (const cli of ['pi', 'codex', 'claude', undefined]) for (const protocolVersion of [undefined, 2]) {
    for (const phase of ['starting', 'running', 'waiting', 'stopping', 'idle', 'closed', 'completed', 'failed', 'stopped', 'unreachable']) {
      const agent = { ...state, cli, protocolVersion, phase };
      const allowed = protocolVersion === 2 && ['pi', 'codex'].includes(cli) && ['starting', 'running', 'waiting'].includes(phase);
      const h = harness(async () => ({ agent, entries: [], loading: true }));
      try {
        await new Promise(setImmediate);
        assert.equal(h.viewer.render(160).join('\n').includes('t interrupt'), allowed, JSON.stringify(agent));
        h.viewer.handleInput('t');
        assert.deepEqual(h.actions, allowed ? [{ kind: 'interrupt', id: state.id }] : []);
        h.viewer.handleInput('t'); assert.equal(h.actions.length, allowed ? 1 : 0);
      } finally { h.viewer.dispose(); }
    }
  }
});

test('viewer leaves Ctrl+C unhandled and preserves k scrolling, composer typing and x release', async t => {
  const actions = [], sent = [];
  const agent = { ...state, cli: 'pi', protocolVersion: 2, phase:'idle', runtimeId:'runtime', questions:[] };
  const tui = { terminal: { rows: 16, columns: 80 }, requestRender() {} };
  const viewer = new ConversationViewer(tui, theme, action => actions.push(action), async () => ({ agent,
    entries: Array.from({ length: 30 }, (_, i) => entry(i)), loading: false }), { intervalMs: 1000, onSend: message => { sent.push(message); } });
  t.after(() => viewer.dispose()); await new Promise(setImmediate);
  viewer.render(80); viewer.handleInput('k'); assert.match(viewer.render(80).join('\n'), /Paused/);
  viewer.handleInput('\x03'); assert.deepEqual(actions, [], 'Ctrl+C is not a child control or viewer dismissal');
  viewer.handleInput('\r'); viewer.handleInput('t'); viewer.handleInput('x'); viewer.handleInput('i'); viewer.handleInput('\x03');
  assert.deepEqual(actions, []); viewer.handleInput('\r'); await new Promise(setImmediate);
  assert.deepEqual(sent, ['txi'], 'the composer owns ordinary letters');
  viewer.handleInput('x'); assert.deepEqual(actions, [{ kind: 'stop', id: agent.id, expected:{runId:agent.runId,runtimeId:agent.runtimeId} }]);
});

test('narrow viewer offers interruption for active work and release only for idle owners while retaining failure evidence', async () => {
  for (const phase of ['running', 'waiting', 'idle']) for (const width of [40, 80]) for (const rows of [8, 16]) {
    const agent = { ...state, cli: 'codex', protocolVersion: 2, runtimeId:'runtime', questions:[], phase, lastStatus: 'failed', error: 'failure evidence '.repeat(20) };
    const viewer = new ConversationViewer({ terminal: { rows, columns: width }, requestRender() {} }, theme, () => {},
      async () => ({ agent, entries: [], loading: false, model: 'long-model-name-for-state-visibility', usageComplete: false }), { onSend() {}, intervalMs: 1000 });
    try {
      await new Promise(setImmediate); const frame = viewer.render(width), text = frame.join('\n');
      assert.ok(frame.length <= rows); assert.ok(frame.every(line => visibleWidth(line) <= width && !/[\r\n]/.test(line)));
      if (phase === 'idle') { assert.match(text, /Idle.*Failed/); assert.match(text, /x release/); assert.doesNotMatch(text, /t interrupt/); }
      else { assert.match(text, /t interrupt/); assert.doesNotMatch(text, /x stop|x release/); viewer.handleInput('x'); }
    } finally { viewer.dispose(); }
  }
});

test('inline feedback uses the single onSend response receipt, not live phase or prior acceptance', async () => {
  for (const [status, expected, color] of [['accepted', /Input accepted for delivery/, 'success'], ['queued', /Input queued/, 'warning'],
    ['unconfirmed', /Delivery unconfirmed/, 'warning'], ['settled', /Run settled/, 'success'], ['released', /Processes released/, 'success'], ['not_running', /No active run/, 'dim']]) {
    const response = { ...state, phase: 'idle', lastStatus: 'completed', accepted: true,
      receipt: { operation: 'send', status, runId: 'receipt-run', runtimeId: 'receipt-runtime' } };
    const actions = [], sent = [], paints = [];
    const capture = { ...theme, fg: (fg, text) => { paints.push({ fg, text }); return text; } };
    const viewer = new ConversationViewer({ terminal: { rows: 20, columns: 400 }, requestRender() {} }, capture, action => actions.push(action),
      async () => ({ agent: { ...state, runId: 'newer-live-run' }, entries: [], loading: false }),
      { intervalMs: 1000, onSend: async message => { sent.push(message); return response; } });
    try {
      await new Promise(setImmediate); viewer.handleInput('\r'); viewer.handleInput('instruction'); viewer.handleInput('\r'); await new Promise(setImmediate);
      const text = viewer.render(400).join('\n'); assert.match(text, expected); assert.match(text, /receipt-run/);
      assert.deepEqual(actions, [], 'an AgentView result is not a panel action');
      assert.deepEqual(sent, ['instruction']);
      assert.ok(paints.some(paint => paint.fg === color && expected.test(paint.text)), status);
      assert.doesNotMatch(text, /model (?:has read|read|executed)|child continues|report will follow/i);
      if (status === 'queued' || status === 'unconfirmed') assert.doesNotMatch(text, /(?:Message|Turn|Input) accepted/);
    } finally { viewer.dispose(); }
  }
});

test('missing receipts do not invent delivery, and failed results remain visible', async () => {
  for (const response of [undefined, { ...state, accepted: true }, { ...state, phase: 'idle', lastStatus: 'failed', error: 'runtime failed',
    receipt: { operation: 'send', status: 'settled', runId: state.runId } }]) {
    const sent = [], actions = [];
    const viewer = new ConversationViewer({ terminal: { rows: 20, columns: 200 }, requestRender() {} }, theme, action => actions.push(action),
      async () => ({ agent: state, entries: [], loading: false }), { intervalMs: 1000,
        onSend: async message => { sent.push(message); return response; } });
    try {
      await new Promise(setImmediate); viewer.handleInput('\r'); viewer.handleInput('input'); viewer.handleInput('\r'); await new Promise(setImmediate);
      const text = viewer.render(200).join('\n');
      assert.match(text, response?.lastStatus === 'failed' ? /Send failed:.*runtime failed/ : /without a.*receipt|Delivery unconfirmed/i);
      assert.doesNotMatch(text, /Message accepted|Turn accepted|report will follow/); assert.deepEqual(actions, []);
      assert.deepEqual(sent, ['input']);
    } finally { viewer.dispose(); }
  }
});

test('same-run accepted and unconfirmed receipts remain visible alongside immediate failure', async () => {
  for (const status of ['accepted', 'unconfirmed']) for (const phase of ['idle', 'closed']) {
    const response = { ...state, phase, lastStatus: 'failed', error: 'immediate runtime failure',
      receipt: { operation: 'send', status, runId: state.runId, runtimeId: 'runtime' } };
    const paints = [], sent = [];
    const capture = { ...theme, fg: (color, text) => { paints.push({ color, text }); return text; } };
    // The live snapshot has not caught up yet: the response alone must reveal the failure.
    const viewer = new ConversationViewer({ terminal: { rows: 20, columns: 200 }, requestRender() {} }, capture, () => {},
      async () => ({ agent: state, entries: [], loading: false }),
      { intervalMs: 1000, onSend: async message => { sent.push(message); return response; } });
    try {
      await new Promise(setImmediate); viewer.handleInput('\r'); viewer.handleInput('once'); viewer.handleInput('\r'); await new Promise(setImmediate);
      const text = viewer.render(200).join('\n');
      assert.match(text, /Send failed:.*immediate runtime failure/); assert.match(text, new RegExp(`receipt: ${status}`, 'i'));
      assert.ok(paints.some(paint => paint.color === 'error' && /immediate runtime failure/.test(paint.text)));
      assert.match(text, new RegExp(state.runId)); assert.deepEqual(sent, ['once']);
      const narrow = viewer.render(80).join('\n'); assert.match(narrow, /Send failed/); assert.match(narrow, new RegExp(`receipt: ${status}`, 'i'));
    } finally { viewer.dispose(); }
  }
});

test('a delivery receipt cannot inherit failure or outcome from a different live run', async () => {
  for (const status of ['accepted', 'queued', 'unconfirmed', 'settled']) {
    const response = { ...state, phase: 'idle', lastStatus: 'failed', error: 'previous run failed',
      receipt: { operation: 'send', status, runId: 'different-run' } };
    const viewer = new ConversationViewer({ terminal: { rows: 20, columns: 200 }, requestRender() {} }, theme, () => {},
      async () => ({ agent: response, entries: [], loading: false }), { intervalMs: 1000, onSend: async () => response });
    try {
      await new Promise(setImmediate); viewer.handleInput('\r'); viewer.handleInput('input'); viewer.handleInput('\r'); await new Promise(setImmediate);
      const text = viewer.render(200).join('\n');
      assert.match(text, /Idle.*Failed/); assert.match(text, /different-run/);
      assert.doesNotMatch(text, /Send failed:|Run settled \(failed\)/);
      if (status === 'unconfirmed') assert.match(text, /Delivery unconfirmed/);
      if (status === 'settled') assert.match(text, /Run settled \(outcome unknown\)/);
    } finally { viewer.dispose(); }
  }
});

test('baseline decision actions are returned untouched without a successful delivery notice', async () => {
  const action = { kind: 'message', id: state.id, resume: true, message: 'original text' }, actions = [], sent = [];
  const viewer = new ConversationViewer({ terminal: { rows: 20, columns: 80 }, requestRender() {} }, theme, value => actions.push(value),
    async () => ({ agent: state, entries: [], loading: false }), { intervalMs: 1000,
      onSend: async message => { sent.push(message); return action; } });
  try {
    await new Promise(setImmediate); viewer.handleInput('\r'); viewer.handleInput('original text'); viewer.handleInput('\r'); await new Promise(setImmediate);
    assert.deepEqual(actions, [action]); assert.equal(actions[0], action); assert.deepEqual(sent, ['original text']);
    assert.doesNotMatch(viewer.render(80).join('\n'), /Input accepted|Input queued|Run settled/);
  } finally { viewer.dispose(); }
});

test('viewer disposal leaves host onSend completion intact without repainting or retrying', async () => {
  let finish, renders = 0, sends = 0;
  const pending = new Promise(resolve => { finish = resolve; }), records = [], actions = [];
  const response = { ...state, receipt: { operation: 'send', status: 'unconfirmed', runId: 'captured-run', runtimeId: 'captured-runtime' } };
  const viewer = new ConversationViewer({ terminal: { rows: 20, columns: 100 }, requestRender() { renders++; } }, theme, action => actions.push(action),
    async () => ({ agent: state, entries: [], loading: false }), { intervalMs: 1000, onSend: async message => {
      sends++;
      const observed = await pending;
      records.push({ message, observed }); // Host-owned work completes even after the viewer closes.
      return observed;
    } });
  try {
    await new Promise(setImmediate); viewer.handleInput('\r'); viewer.handleInput('once'); viewer.handleInput('\r');
    viewer.dispose(); const before = renders;
    finish(response); await new Promise(setImmediate);
    assert.equal(sends, 1); assert.deepEqual(actions, []); assert.equal(renders, before);
    assert.deepEqual(records, [{ message: 'once', observed: response }]); assert.equal(records[0].observed, response);
  } finally { viewer.dispose(); }
});
