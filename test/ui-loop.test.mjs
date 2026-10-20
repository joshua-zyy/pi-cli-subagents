// Integration checks: TUI widget lifecycle and panel actions through the real manager.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import extension from '../dist/index.js';
import { waitUntil, processAlive } from '../dist/storage.js';
import { AgentManager } from '../dist/manager.js';
import { tempDir } from './helpers/tmp.mjs';
import { SPINNER } from '../dist/ui/format.js';
import { FRAME_INTERVAL_MS } from '../dist/ui/status.js';
import { AgentsPanel } from '../dist/ui/panel.js';
import { TuiAltScreen, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
const { createChatViewport } = await import(new URL('./modes/interactive/chat-viewport.js', import.meta.resolve('@earendil-works/pi-coding-agent')));

const fixture = fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url));
const theme = { fg: (_color, text) => text, bold: (text) => text };
const keys = { up: '\u001b[A', down: '\u001b[B', enter: '\r', escape: '\u001b' };
const json = (text) => JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));

function waitForIdle(manager, id, lastStatus = 'completed') {
  return waitUntil(`run ${lastStatus} with resident runtime`, () => {
    const state = manager.get(id);
    return state.phase === 'idle' && state.lastStatus === lastStatus ? state : undefined;
  });
}

/** Native restart and workspace handoff need release, not just a finished run. */
async function closeCompleted(manager, id) {
  const idle = await waitForIdle(manager, id);
  const closed = await manager.close(id);
  assert.equal(closed.phase, 'closed');
  assert.equal(closed.lastStatus, idle.lastStatus, 'release must preserve the completed run outcome');
  await waitUntil('runtime owner released', () => !fs.existsSync(path.join(manager.root, id, 'owner.lock')));
  return closed;
}

function harness(t, tui) {
  const cwd = tempDir('ui-loop');
  const parent = path.join(cwd, 'parent.jsonl'); fs.writeFileSync(parent, '{}\n');
  const state = {
    cwd, parent, entries: [], messages: [], notices: [], widgetCalls: [], editors: [], confirms: [],
    scripts: [], customCalls: 0, customActive: 0, customs: [], mode: 'tui', editorAnswer: '', confirmAnswer: true, listeners: [], selections: [], selectAnswer: undefined,
  };
  const surfaceTui = tui ?? { terminal: { columns: 120, rows: 35 }, requestRender() {} };
  const ctx = {
    cwd, hasUI: true, isProjectTrusted: () => false,
    get mode() { return state.mode; },
    sessionManager: { getSessionFile: () => parent, getEntries: () => state.entries },
    ui: {
      // Pi's editor border follows the thinking level; the viewer reuses it for its frame.
      theme: { getThinkingBorderColor: () => (text) => text, fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text },
      notify(message, type) { state.notices.push({ message, type }); },
      setStatus() {},
      setWidget(key, content, options) {
        state.widgetCalls.push({ key, content, options });
        if(key!=='cli-subagents-agents')return;
        const prior=state.customs.findLast(entry=>entry.roster&&entry.active);if(prior)prior.active=false;
        if(typeof content==='function')state.customs.push({component:content(surfaceTui,ctx.ui.theme),options,active:true,roster:true,widgetFactory:content});
      },
      onTerminalInput(listener) {
        state.listeners.push(listener); const remove = tui?.addInputListener?.(listener);
        return () => { state.listeners.splice(state.listeners.indexOf(listener), 1); remove?.(); };
      },
      getEditorText() { return ''; },
      custom(factory, options) {
        state.customCalls += 1; state.customActive += 1;
        return new Promise((resolve, reject) => {
          let settled = false, entry, overlay;
          const done = (result) => {
            if (settled) return;
            settled = true; state.customActive -= 1;
            if (entry) entry.active = false;
            overlay?.hide(); resolve(result);
          };
          const component = factory(surfaceTui, theme, {}, done);
          entry = { component, options, active: !settled, roster: component instanceof AgentsPanel };
          state.customs.push(entry);
          if (tui?.showOverlay && !settled) {
            assert.equal(options?.overlay, true, 'interactive panels use the native overlay layer');
            overlay = tui.showOverlay(component, options.overlayOptions);
          }
          if (entry.roster) return;
          const script = state.scripts.shift() ?? [];
          if (typeof script === 'function') { Promise.resolve(script(component, done)).catch(reject); return; }
          for (const key of script) component.handleInput(key);
          if (!settled) done(undefined);
        });
      },
      async editor(title) { state.editors.push(title); return state.editorAnswer; },
      async confirm(title, message) { state.confirms.push({ title, message }); return state.confirmAnswer; },
      async select(title, options) {
        assert.equal(state.customActive, 0, 'close custom overlays before opening a baseline dialog');
        state.selections.push({ title, options });
        return typeof state.selectAnswer === 'function' ? state.selectAnswer(title, options) : state.selectAnswer;
      },
      async input() { return undefined; },
    },
  };
  const handlers = {}, tools = new Map(), commands = new Map(), shortcuts = new Map();
  const pi = {
    on(name, handler) { handlers[name] = handler; },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    registerShortcut(key, shortcut) { shortcuts.set(key, shortcut); },
    registerMessageRenderer() {},
    sendMessage(message, options) { state.messages.push({ message, options }); state.entries.push({ type: 'custom_message', ...message }); },
  };
  const manager = new AgentManager(parent, { command: process.execPath, args: [fixture] });
  // Replace the child Pi entry with the deterministic fixture, as in extension.test.mjs.
  const savedArgv = process.argv[1];
  process.argv[1] = fixture;
  t.after(async () => {
    handlers.session_shutdown?.();
    for (const agent of manager.list()) if (fs.existsSync(path.join(manager.root, agent.id, 'owner.lock'))) await manager.close(agent.id);
    process.argv[1] = savedArgv;
  });
  return {
    // Getters keep test observations live instead of returning stale primitive snapshots.
    state, ctx, pi, handlers, tools, commands, shortcuts, manager, tui: surfaceTui,
    get customCalls() { return state.customCalls; },
    get viewerCalls() { return state.customs.filter(entry => !entry.roster).length; },
    get messages() { return state.messages; },
    get notices() { return state.notices; },
    get widgetCalls() { return state.widgetCalls; },
    get editors() { return state.editors; },
    get confirms() { return state.confirms; },
    get editorAnswer() { return state.editorAnswer; },
    set editorAnswer(value) { state.editorAnswer = value; },
    set mode(value) { state.mode = value; },
    start() {
      // Catalog/default discovery must not see or start the machine's optional native CLIs.
      const savedPath = process.env.PATH; process.env.PATH = '';
      try { extension(pi); handlers.session_start({ type: 'session_start', reason: 'startup' }, ctx); }
      finally { if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath; }
    },
    async invoke(tool, params) {
      return (await tools.get(tool).execute('id', params, undefined, undefined, ctx)).content[0].text;
    },
    async spawn(task, role = 'worker') {
      return json(await this.invoke('subagent', { action: 'start', role, task, cwd }));
    },
    async openAgents({ shortcut = false } = {}) {
      const customBefore = state.customs.length;
      const running = shortcut ? shortcuts.get('ctrl+alt+a').handler(ctx) : commands.get('agents').handler('', ctx);
      const current = () => state.customs.slice(customBefore).findLast(entry => entry.roster);
      await waitUntil('agents panel', current);
      const press = (key) => waitUntil(`the agents panel to accept ${JSON.stringify(key)}`, () => {
        const entry = current();
        if (!entry?.active) return undefined;
        return state.listeners.at(-1)?.(key);
      });
      return { running, render: (width = 100) => current().component.render(width).join('\n'), press };
    },
  };
}

test('fixed dock keeps its frame, input and selected identity through resize and internal navigation', async t => {
  const terminal = { rows: 35, columns: 160, kittyProtocolActive: false,
    start(input, resize) { this.input = input; this.resize = resize; }, stop() {}, async drainInput() {},
    write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {} };
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const h = harness(t, tui), agents = Array.from({ length: 9 }, (_, i) => ({
    id: `agent00${i}`, runId: 'run', runtimeId: 'runtime', protocolVersion: 3, role: 'explore', phase: 'idle', lastStatus: 'completed',
    questions: [], startedAt: i, updatedAt: 1000, task: `Task ${i}`, history: [], runCount: 1,
  }));
  t.mock.method(AgentManager.prototype, 'list', () => agents);
  t.mock.method(AgentManager.prototype, 'reports', () => []);
  const fixed = lines => ({ render: () => lines, invalidate() {} });
  const components = new WeakMap();
  const widgetsAbove = { invalidate() {}, render(width) {
    const slots = new Map();
    for (const call of h.widgetCalls) {
      if (call.content === undefined) slots.delete(call.key); else slots.set(call.key, call.content);
    }
    return ['', ...[...slots.values()].flatMap(content => {
      if (!components.has(content)) components.set(content, h.state.customs.find(entry=>entry.widgetFactory===content)?.component??content(tui, theme));
      return components.get(content).render(width);
    })];
  } };
  let editorRows=3;const editorKeys=[];
  const editor={focused:false,render:()=>['EDITOR','INPUT',...Array(editorRows-3).fill('WRAPPED-DRAFT'),'EDITOR'],invalidate(){},handleInput:key=>editorKeys.push(key)};
  const { root } = createChatViewport({ document: fixed(['CHAT']), pendingMessages: fixed([]), status: fixed([]), widgetsAbove,
    editor, footer: fixed(Array(2).fill('FOOTER')) });
  tui.setLayoutRoot(root);tui.setFocus(editor);tui.start();
  let pane;
  try {
    h.start();
    h.ctx.ui.setWidget('fixture-todos', () => fixed(Array(6).fill('TODO')));
    pane = await h.openAgents();
    for (let i = 0; i < 6; i++) terminal.input(keys.down);
    for (const [columns, rows, draftRows=3] of [[160, 35], [100, 30], [60, 24], [60, 16, 7], [40, 12], [40, 10], [180, 45]]) {
      editorRows=draftRows;
      // External widgets cannot all fit a ten-line terminal; exercise coexistence where room exists.
      h.ctx.ui.setWidget('fixture-todos',rows>=24?()=>fixed(Array(6).fill('TODO')):undefined);
      terminal.columns = columns; terminal.rows = rows; terminal.resize(); tui.renderNow(true);
      const screen = tui.getScreenLines().map(stripTerminalSequences);
      assert(screen.some(line => line.includes('›') && line.includes('agent006')), `selected identity clipped at ${columns}x${rows}`);
      assert(screen.some(line => /^╭─+╮$/.test(line)), `top frame clipped at ${columns}x${rows}`);
      assert(screen.some(line => /^╰─+╯$/.test(line)), `bottom frame clipped at ${columns}x${rows}`);
      assert(screen.every(line => visibleWidth(line) <= columns && !/[\r\n]/.test(line)));
      assert.equal(tui.hasOverlay(),false);assert(screen.includes('INPUT'));assert(screen.some(line=>line.includes('CHAT')));
      assert(screen.findIndex(line=>/^╰─+╯$/.test(line))<screen.indexOf('INPUT'));
      if (rows === 45) for (const agent of agents) assert(screen.some(line => line.includes(agent.id)), `roomy viewport unnecessarily hides ${agent.id}`);
    }
    h.ctx.ui.setWidget('fixture-todos',undefined);terminal.rows = 10; terminal.columns = 60; terminal.resize();
    for (let i = 0; i < agents.length; i++) terminal.input(keys.up);
    let selected=0;
    for (const direction of [keys.down, keys.up]) for (let i = 0; i < agents.length; i++) {
      tui.renderNow(true);
      assert(tui.getScreenLines().map(stripTerminalSequences).some(line=>line.includes('›')&&line.includes(agents[selected].id)));
      terminal.input(direction);
      selected=Math.max(0,Math.min(agents.length-1,selected+(direction===keys.down?1:-1)));
    }
    terminal.input(keys.escape); await pane.running; tui.renderNow(true);
    assert(!tui.hasOverlay());assert.equal(tui.getFocusedComponent(),editor,'the pane never replaces parent editor focus');
    terminal.input('z');assert.deepEqual(editorKeys,['z'],'navigation is consumed and Esc restores ordinary input');
  } finally {
    h.handlers.session_shutdown?.(); if (pane) await pane.running; tui.stop();
  }
});

test('one monitor tick shares one live snapshot across reports and status without a bottom selector', t => {
  const h = harness(t), original = AgentManager.prototype.list;
  let calls = 0, phase = 'running';
  AgentManager.prototype.list = function () {
    calls++;
    return [{ id: '00000000-0000-4000-8000-000000000001', runId: 'run', role: 'worker', phase,
      workerPid: process.pid, updatedAt: Date.now(), startedAt: Date.now(), questions: [], history: [], runCount: 1 }];
  };
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    h.start(); t.mock.timers.tick(100);
    assert.equal(calls, 1, 'report delivery and the status widget share one manager list');
    const components = h.widgetCalls.filter(call => typeof call.content === 'function')
      .map(call => call.content({ terminal: { columns: 120 }, requestRender() {} }, theme));
    assert.equal(components.length, 1);
    assert(!h.widgetCalls.some(call=>call.options?.placement==='belowEditor'));
    assert.equal(h.state.listeners.length,0,'monitoring must not intercept prompt arrow keys');
    t.mock.timers.tick(500);
    assert.equal(calls, 1, 'animation between monitor ticks must not read another snapshot');
    // Completion remains in manager history, not in the current-work widget.
    phase = 'completed'; t.mock.timers.tick(200);
    assert.equal(calls, 2);
    assert.ok(components.every(component => component.render(120).length === 0));
    assert.equal(h.widgetCalls.filter(call=>call.key==='cli-subagents').at(-1).content,undefined);
  } finally {
    h.handlers.session_shutdown?.(); t.mock.timers.reset(); AgentManager.prototype.list = original;
  }
});

test('open roster shares the status widget animation clock without extra reads or timers', async t => {
  let calls = 0, redraws = 0;
  const h = harness(t, { terminal: { columns: 160, rows: 35 }, requestRender() { redraws++; } }), original = AgentManager.prototype.list;
  const agent = { id: '00000000-0000-4000-8000-000000000001', runId: 'run', role: 'worker', phase: 'running',
    workerPid: process.pid, updatedAt: Date.now(), startedAt: Date.now(), questions: [], history: [], runCount: 1 };
  AgentManager.prototype.list = function () { calls++; return [agent]; };
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let running;
  try {
    h.start(); t.mock.timers.tick(100);
    running = h.commands.get('agents').handler('', h.ctx);
    const outer = h.widgetCalls.find(call => call.key === 'cli-subagents' && typeof call.content === 'function').content(h.tui, theme);
    const pane = h.state.customs.at(-1).component;
    const reads = calls, renders = redraws;
    for (let frame = 0; frame < 4; frame++) {
      assert.deepEqual(outer.render(160),[],'the open roster hides the duplicate activity summary without stopping its clock');
      assert(pane.render(160).join('\n').includes(`${SPINNER[frame]} worker`), `roster frame ${frame}`);
      if (frame < 3) t.mock.timers.tick(FRAME_INTERVAL_MS);
    }
    assert.equal(calls, reads, 'animation must not poll the manager');
    assert.equal(redraws - renders, 3, 'one shared 80ms timer requests rendering, not a second pane timer');
    h.state.listeners.at(-1)('q'); await running;
    const closedRenders = redraws;
    t.mock.timers.tick(FRAME_INTERVAL_MS);
    assert.equal(redraws, closedRenders + 1, 'closing the pane leaves only the existing outer animation');
    assert(outer.render(160).join('\n').includes(`${SPINNER[4]} worker`),'closing the roster restores the active summary');
    h.handlers.session_shutdown(); const stopped = redraws;
    t.mock.timers.tick(1000); assert.equal(redraws, stopped, 'shutdown stops the shared animation');
  } finally {
    h.handlers.session_shutdown?.(); await running;
    t.mock.timers.reset(); AgentManager.prototype.list = original;
  }
});

test('open roster consumes monitor snapshots, updates elapsed time and detaches on close or session change', async t => {
  let calls = 0, redraws = 0;
  const h = harness(t, { terminal: { columns: 160, rows: 35 }, requestRender() { redraws++; } }), original = AgentManager.prototype.list;
  const agent = { id: '00000000-0000-4000-8000-000000000001', runId: 'run', runtimeId: 'runtime', protocolVersion: 3,
    role: 'worker', phase: 'running', workerPid: process.pid, updatedAt: 1000, startedAt: 1000, questions: [], history: [], runCount: 1 };
  let snapshot = [agent];
  AgentManager.prototype.list = function () { calls++; return snapshot; };
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000 });
  let running;
  const open = () => {
    running = h.commands.get('agents').handler('', h.ctx);
    const pane = h.state.customs.at(-1).component;
    return () => pane.render(160).join('\n');
  };
  try {
    h.start(); t.mock.timers.tick(100);
    const rendered = open(), reads = calls;
    assert.match(rendered(), /Running · 0\.1s/);
    t.mock.timers.tick(200); assert.match(rendered(), /Running · 0\.3s/, 'elapsed time is not frozen at pane construction');
    assert.equal(calls, reads, 'animation/rendering must not read state');
    snapshot = [{ ...agent, phase: 'idle', lastStatus: 'completed', updatedAt: 1400 }];
    t.mock.timers.tick(500);
    assert.equal(calls, reads + 1, 'the existing monitor supplies exactly one shared read');
    assert.match(rendered(), /Idle.*Completed/); assert.match(rendered(), /c release idle \(1\)/);
    snapshot = [{ ...agent, phase: 'waiting', questions: [{ id: 'q', method: 'confirm', title: 'Current question' }] }];
    t.mock.timers.tick(800); h.state.listeners.at(-1)('i');
    assert.match(rendered(), /Current question/); assert.match(rendered(), /r reply/);
    snapshot = [{ ...agent, phase: 'closed', runtimeClosed: true }];
    const beforeRelease = redraws; t.mock.timers.tick(800);
    assert(redraws > beforeRelease, 'the pane redraws even when all outer status rows disappear');
    assert.match(rendered(), /Subagents \(0\)/); assert.match(rendered(), /h history/);
    h.state.listeners.at(-1)('q'); await running;
    const closedRedraws = redraws;
    snapshot = [{ ...agent, role: 'replacement', phase: 'idle' }]; t.mock.timers.tick(800);
    assert.equal(redraws, closedRedraws, 'closed panes receive no snapshots or redraws');
    assert.doesNotMatch(rendered(), /replacement/);
    const replacement = open(); assert.match(replacement(), /replacement/);
    const savedPath = process.env.PATH; process.env.PATH = '';
    try { h.handlers.session_start({ type: 'session_start', reason: 'resume' }, h.ctx); }
    finally { if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath; }
    await running; const switchedRedraws = redraws;
    snapshot = [{ ...agent, role: 'different-parent', phase: 'idle' }]; t.mock.timers.tick(1000);
    assert.equal(redraws, switchedRedraws); assert.doesNotMatch(replacement(), /different-parent/);
    assert.equal(h.state.listeners.length, 0);
  } finally {
    h.handlers.session_shutdown?.(); await running;
    t.mock.timers.reset(); AgentManager.prototype.list = original;
  }
});

test('status widget shows active work then unregisters when the worker becomes resident idle', { timeout: 20_000 }, async (t) => {
  const h = harness(t);
  h.start();
  const agent = await h.spawn('HOLD widget');
  const registered = await waitUntil('widget registration', () => h.widgetCalls.find((call) => typeof call.content === 'function'));
  assert.equal(registered.key, 'cli-subagents');
  const component = registered.content({ terminal: { columns: 120 }, requestRender() {} }, theme);
  const rendered = () => component.render(120).join('\n');
  assert.match(rendered(), /worker/, 'widget must show the role');
  assert.match(rendered(), /\d+\.\d+s/, 'widget must show elapsed time');
  await h.manager.interrupt(agent.id);
  const idle = await waitForIdle(h.manager, agent.id, 'stopped');
  assert.equal(idle.protocolVersion, 3);
  assert.equal(processAlive(idle.workerPid), true, 'hiding idle must not release the worker');
  assert.ok(fs.existsSync(path.join(h.manager.root, agent.id, 'owner.lock')));
  await waitUntil('idle removes the activity widget', () => h.widgetCalls.filter(call=>call.key==='cli-subagents').at(-1)?.content === undefined);
  assert.equal(rendered(), '');
  component.invalidate();
  h.handlers.session_shutdown?.();
  const last = h.widgetCalls.filter(call=>call.key==='cli-subagents').at(-1);
  assert.equal(last.content, undefined, 'parent shutdown unregisters status');
  assert(!h.widgetCalls.some(call=>call.key==='cli-subagents-fleet'));
  assert.equal(h.state.listeners.length,0,'no persistent prompt key listener');
});

test('roster history resumes original sessions, releases only idle children, and rejects non-TUI use', { timeout: 30_000 }, async (t) => {
  const h = harness(t);
  h.start();
  const agent = await h.spawn('REMEMBER panel-token');
  // This case specifically tests native resume, not an idle same-runtime continuation.
  const original = await closeCompleted(h.manager, agent.id);
  const sessionId = original.sessionId;
  const firstRun = original.runId;

  // Open details, send through the editor, then close the restored roster.
  h.editorAnswer = 'RECALL';
  const pane = await h.openAgents();
  assert.match(pane.render(), /^╭─+╮$/m, 'the roster is framed like the role editor');
  assert.match(pane.render(), /Subagents \(0\)/);
  assert.doesNotMatch(pane.render(), new RegExp(agent.id.slice(0,8)));
  await pane.press('h'); assert.match(pane.render(), /Subagents \(1\)/);
  await pane.press('i'); await pane.press('s');
  await pane.press(keys.escape); await pane.running;
  assert.equal(h.viewerCalls, 0);
  assert(h.state.customs.filter(entry => entry.roster).every(entry => entry.options?.placement === 'aboveEditor'&&entry.options?.overlay===undefined), 'rosters use the public above-editor widget');
  assert.match(h.editors[0], /Resume worker/);
  assert(h.state.customs.every(entry => !entry.active), 'the roster closes before host dialogs and after dismissal');
  await waitUntil('resumed report', () => h.messages.some((entry) => entry.message.content.includes('panel-token')));
  const resumed = await waitForIdle(h.manager, agent.id);
  assert.equal(resumed.sessionId, sessionId, 'resume must retain the original session');
  assert.notEqual(resumed.runId, firstRun);
  assert.notEqual(resumed.runtimeId, original.runtimeId, 'native resume starts a new runtime');

  // HOLD is second by start time; x must never release an executing child.
  const holding = await h.spawn('HOLD');
  await waitUntil('running', () => h.manager.get(holding.id).phase === 'running');
  const stop = await h.openAgents();
  await stop.press(keys.down); await stop.press('i'); await stop.press('x');
  await stop.press(keys.escape); await stop.press(keys.escape); await stop.running;
  assert.equal(h.confirms.length, 0);
  assert.equal(h.manager.get(holding.id).phase, 'running');
  assert.equal(fs.existsSync(path.join(h.manager.root, holding.id, 'owner.lock')), true);
  const release = await h.openAgents();
  await release.press('i'); await release.press('x'); await release.press(keys.escape); await release.running;
  assert.equal(h.confirms.length, 1); assert.match(h.confirms[0].title, /Release idle/);
  assert.equal(h.manager.get(agent.id).phase, 'closed'); assert.equal(h.manager.get(agent.id).lastStatus, 'completed');
  assert.equal(h.manager.get(holding.id).phase, 'running');
  const current=await h.openAgents(); assert.doesNotMatch(current.render(160),new RegExp(agent.id.slice(0,8)));
  assert.match(current.render(160),new RegExp(holding.id.slice(0,8))); await current.press(keys.escape); await current.running;

  // Non-TUI clients do not open a panel.
  h.mode = 'rpc';
  const before = h.customCalls, widgets = h.widgetCalls.length;
  await commands0(h);
  assert.equal(h.customCalls, before);
  assert.equal(h.widgetCalls.length, widgets, 'no pane is registered without a TUI');
  assert.equal(h.notices.at(-1).type, 'error');
  assert.match(h.notices.at(-1).message, /TUI/);
});

test('idle batch refuses a newly busy captured target, releases its idle sibling and preserves every original report', { timeout: 35000 }, async t => {
  const h = harness(t); h.start();
  const a = await h.spawn('first result'), first = await waitForIdle(h.manager, a.id);
  const b = await h.spawn('second result'), second = await waitForIdle(h.manager, b.id);
  const active = await h.spawn('HOLD active'), waiting = await h.spawn('WAIT');
  await waitUntil('mixed running and waiting roster', () => h.manager.get(active.id).phase === 'running' && h.manager.get(waiting.id).phase === 'waiting');
  const results = [first, second].map(state => JSON.stringify(h.manager.getResult(state.id, state.runId)));
  h.ctx.ui.confirm = async (title, message) => {
    h.state.confirms.push({ title, message });
    assert.match(title, /idle/i); assert(message.includes(a.id)); assert(message.includes(b.id));
    assert(!message.includes(active.id)); assert(!message.includes(waiting.id));
    // New work starts only after the UI has captured and displayed its candidate set.
    await h.manager.send(a.id, 'HOLD new run after list');
    return true;
  };
  const pane = await h.openAgents();
  assert.match(pane.render(140), /c.*release idle/i);
  await pane.press('c'); await pane.press(keys.escape); await pane.running;
  assert.equal(h.confirms.length, 1);
  const current = h.manager.get(a.id);
  assert.equal(current.phase, 'running'); assert.notEqual(current.runId, first.runId); assert.equal(current.runtimeId, first.runtimeId);
  assert.equal(h.manager.get(b.id).phase, 'closed');
  assert.equal(h.manager.get(active.id).phase, 'running'); assert.equal(h.manager.get(waiting.id).phase, 'waiting');
  assert.deepEqual([first, second].map(state => JSON.stringify(h.manager.getResult(state.id, state.runId))), results);
  const human = h.messages.filter(entry => entry.message.customType === 'cli-subagents-human-action');
  assert.equal(human.length, 1); assert(human.every(entry => entry.options.triggerTurn === false));
  assert.deepEqual(human[0].message.details.batch, { total: 2, released: 1, unconfirmed: 1, notAttempted: 0, unknown: 0, interrupted: false });
  for (const value of [a.id, first.runId, first.runtimeId, b.id, second.runId, second.runtimeId]) assert(human[0].message.content.includes(value));
  assert.match(human[0].message.content, /unconfirmed/i);
  assert.match(human[0].message.content, /Native processes released/);
  assert(h.notices.some(notice => notice.type === 'warning' && notice.message.includes(a.id) && notice.message.includes(b.id)));
});

function commands0(h) { return h.commands.get('agents').handler('', h.ctx); }

test('direct human actions are recorded for the parent without interrupting it', { timeout: 30_000 }, async (t) => {
  const h = harness(t);
  h.start();
  const holding = await h.spawn('HOLD human-sync');
  await waitUntil('running', () => h.manager.get(holding.id).phase === 'running');
  const human = () => h.messages.filter((entry) => entry.message.customType === 'cli-subagents-human-action');

  // A routine instruction: the parent must see it, but sibling work must not be interrupted.
  h.editorAnswer = 'HOLD and also check the docs';
  const instruct = await h.openAgents();
  await instruct.press('i'); await instruct.press('s');
  await instruct.press(keys.escape); await instruct.running;
  await waitUntil('instruction recorded', () => human().length === 1);
  assert.equal(human()[0].options.triggerTurn, false);
  assert.match(human()[0].message.content, new RegExp(holding.id));
  assert.match(human()[0].message.content, /worker\] Requested input: "HOLD and also check the docs"/);
  assert.match(human()[0].message.content, /does not widen the task's original authorization/);
  assert.equal(human()[0].message.details.agentId, holding.id);
  assert.equal(human()[0].message.details.ids, undefined, 'human entries must not count as report receipts');
  assert.equal(h.manager.get(holding.id).phase, 'running', 'steering must not end the run');

  // A human permission decision is the most consequential direct action.
  const asking = await h.spawn('WAIT');
  await waitUntil('waiting', () => h.manager.get(asking.id).phase === 'waiting');
  const reply = await h.openAgents();
  await reply.press(keys.down); await reply.press('i'); await reply.press('r');
  await reply.press(keys.escape); await reply.running;
  await waitUntil('decision recorded', () => human().length === 2);
  assert.match(human()[1].message.content, new RegExp(`${asking.id}.*worker\\] Answered pending request permission-1: confirmed`, 's'));

  // End the active turn separately; only then can its idle runtime be released.
  const interrupt = await h.openAgents(); await interrupt.press('t'); await interrupt.press(keys.escape); await interrupt.running;
  await waitForIdle(h.manager,holding.id,'stopped'); await waitUntil('interrupt recorded',()=>human().length===3);
  assert.match(human()[2].message.content,/captured turn has ended/);
  const stop = await h.openAgents();
  await stop.press('i'); await stop.press('x');
  await stop.press(keys.escape); await stop.running;
  await waitUntil('release recorded', () => human().length === 4);
  assert.match(human()[3].message.content, new RegExp(`${holding.id}.*Native processes released`, 's'));
  assert.equal(h.manager.get(holding.id).phase, 'closed');
  assert.equal(h.manager.get(holding.id).lastStatus, 'stopped');
  assert.equal(fs.existsSync(path.join(h.manager.root, holding.id, 'owner.lock')), false);

  // Report delivery still works alongside the new entries.
  await waitUntil('child reports still arrive', () => h.messages.some((entry) => entry.message.customType === 'cli-subagents-report'));
  const reports = h.messages.filter((entry) => entry.message.customType === 'cli-subagents-report');
  assert.ok(reports.every((entry) => entry.options.triggerTurn === true));
});

test('Codex choice dialogs retain the command details and cancel without a persistent grant', { timeout: 20_000 }, async t => {
  const h = harness(t); h.start();
  const home = path.join(h.state.cwd, 'codex-home'); fs.mkdirSync(home); fs.writeFileSync(path.join(home, 'fixture-home'), '');
  const codexFixture = fileURLToPath(new URL('./fixtures/codex.mjs', import.meta.url));
  const manager = new AgentManager(h.state.parent, { command: process.execPath, args: [fixture] }, { home, launch: { command: process.execPath, args: [codexFixture] } });
  const child = await manager.spawn('codex-worker', { cli: 'codex', model: 'gpt-6-luna', description: 'fixture', instructions: 'test' }, h.state.cwd, 'APPROVAL_ACCEPT_CANCEL');
  await waitUntil('Codex choice', () => manager.get(child.id).questions[0]);
  h.state.selectAnswer = '2. Cancel turn';
  const pane = await h.openAgents(); await pane.press('i'); await pane.press('r');
  await waitUntil('human Codex decision', () => h.messages.some(e => e.message.customType === 'cli-subagents-human-action'));
  await pane.press(keys.escape); await pane.running;
  const dialog = h.state.selections.at(-1);
  assert.match(dialog.title, /Command: write fixture-only/); assert.match(dialog.title, /Directory:/);
  assert.match(dialog.title, /Cancel turn ends this turn/); assert.deepEqual(dialog.options, ['1. Approve once', '2. Cancel turn']);
  const cancelled = await waitForIdle(manager, child.id, 'stopped');
  assert.equal(processAlive(cancelled.workerPid), true, 'Cancel turn must not close the resident runtime');
  assert.ok(fs.existsSync(path.join(manager.root, child.id, 'owner.lock')));
  assert.ok(h.messages.some(e => e.message.customType === 'cli-subagents-human-action' && e.message.content.includes('Cancel turn')));
  assert.equal(h.confirms.length, 0, 'no boolean dialog may hide cancel-vs-decline semantics');
});

test('agents panel answers a running Codex async question once without starting another turn', { timeout: 20_000 }, async t => {
  const h = harness(t); h.start();
  const home = path.join(h.state.cwd, 'codex-home'); fs.mkdirSync(home); fs.writeFileSync(path.join(home, 'fixture-home'), '');
  const codexFixture = fileURLToPath(new URL('./fixtures/codex.mjs', import.meta.url));
  const manager = new AgentManager(h.state.parent, { command: process.execPath, args: [fixture] }, { home, launch: { command: process.execPath, args: [codexFixture] } });
  const child = await manager.spawn('codex-worker', { cli: 'codex', model: 'fixture', description: 'fixture', instructions: 'test' }, h.state.cwd, 'ASYNC_QUESTION_DUPLICATE');
  const pending = await waitUntil('non-blocking request', () => { const s=manager.get(child.id); return s.questions.length?s:undefined; });
  assert.equal(pending.phase, 'running'); assert.equal(pending.questions[0].isBlocking, false);
  h.state.selectAnswer = (_title, options) => options[0]; h.ctx.ui.input = async () => 'Authorized task context';
  const pane = await h.openAgents(); await pane.press('i'); assert.match(pane.render(), /r reply/);
  await pane.press('r');
  const final = await waitForIdle(manager, child.id);
  await waitUntil('one human reply receipt', () => h.messages.some(e => e.message.customType === 'cli-subagents-human-action'));
  await pane.press(keys.escape); await pane.running;
  assert.equal(final.runId, child.runId); assert.equal(final.runtimeId, child.runtimeId); assert.deepEqual(final.session, child.session);
  assert.equal(final.text, 'Answers to your questions:\n\nWhich check?\nUnit\n\nWhat context is missing?\nAuthorized task context');
  const requests = fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(requests.filter(r => r.method === 'turn/start').length, 1); assert.equal(requests.filter(r => r.method === 'turn/steer').length, 1);
  const audit = fs.readFileSync(path.join(manager.root, child.id, 'runs', child.runId, 'permissions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(audit.length, 1); assert.equal(audit[0].actor, 'human'); assert.equal(audit[0].questionId, pending.questions[0].id);
  const actions = h.messages.filter(e => e.message.customType === 'cli-subagents-human-action');
  assert.equal(actions.length, 1); assert.equal(actions[0].options.triggerTurn, false); assert.deepEqual(final.questions, []);
});

test('shortcut selects a running child and opens its live conversation directly', { timeout: 15000 }, async t => {
  const h = harness(t); h.start();
  assert.ok(h.shortcuts.has('ctrl+alt+a'));
  const first = await h.spawn('HOLD one');
  const second = await h.spawn('HOLD two');
  await waitUntil('both active', () => h.manager.get(first.id).phase === 'running' && h.manager.get(second.id).phase === 'running');
  h.state.scripts.push(async viewer => {
    await waitUntil('selected agent loaded', () => viewer.render(100).join('\n').includes(second.id.slice(0,8)));
    assert.match(viewer.render(100).join('\n'), /HOLD two/);
    viewer.handleInput('q');
  });
  const pane = await h.openAgents({ shortcut: true });
  await pane.press(keys.down); await pane.press(keys.enter);
  await pane.press(keys.escape); await pane.running;
  assert.equal(h.viewerCalls, 1, 'the shortcut opens the selected conversation once');
  assert.equal(h.manager.get(first.id).phase,'running');
  assert.equal(h.manager.get(second.id).phase,'running');
});

test('inline message from the viewer reaches the running child in the same session', {timeout:20000}, async t => {
  const h=harness(t);h.start();
  const agent=await h.spawn('HOLD inline');
  await waitUntil('running',()=>h.manager.get(agent.id).phase==='running');
  const sessionId=h.manager.get(agent.id).sessionId;
  h.state.scripts.push(async viewer=>{
    await waitUntil('viewer ready',()=>viewer.render(120).join('\n').includes('HOLD inline')||viewer.render(120).join('\n').includes('worker'));
    viewer.handleInput('\r'); // open the inline composer
    for(const key of 'PING') viewer.handleInput(key);
    viewer.handleInput('\r');
    const finished = await waitForIdle(h.manager, agent.id);
    assert.equal(finished.runId, agent.runId, 'steering must finish the existing run');
    assert.equal(finished.runtimeId, agent.runtimeId, 'steering must keep the same runtime');
    assert.equal(h.manager.get(agent.id).sessionId,sessionId,'steering must stay in the original session');
    assert.equal(h.manager.get(agent.id).text,'PING');
    viewer.handleInput('q');
  });
  const pane=await h.openAgents();
  await pane.press(keys.enter);
  await pane.press(keys.escape);await pane.running;
  assert.equal(h.editors.length,0,'inline send must not open the external editor dialog');
});

test('conversation is wired to live worker logs and remains open after completion', { timeout: 15000 }, async t => {
  const h = harness(t); h.start();
  const agent = await h.spawn('STREAM');
  h.state.scripts.push(async viewer => {
    const text = () => viewer.render(120).join('\n');
    await waitUntil('compact tool summary', () => text().includes('src/example.ts'));
    assert.doesNotMatch(text(), /partial fixture output/);
    viewer.handleInput('\x0f');
    await waitUntil('streaming tool details', () => text().includes('partial fixture output'));
    assert.match(text(), /src\/example.ts/);
    await waitUntil('final tool output', () => text().includes('final fixture output'));
    await waitForIdle(h.manager, agent.id);
    assert.match(text(), /Implementation complete/);
    viewer.handleInput('q');
  });
  const pane = await h.openAgents();
  await pane.press(keys.enter);
  await pane.press(keys.escape); await pane.running;
  assert.equal(h.viewerCalls, 1, 'closing the viewer returns to the roster without reopening the viewer');
  assert.equal(h.manager.get(agent.id).phase, 'idle');
  assert.equal(h.manager.get(agent.id).lastStatus, 'completed');
  assert.equal(h.manager.eventLogs(agent.id).length, 1);
  assert.throws(() => h.manager.eventLogs('foreign'), /id/);
});

test('the viewer reads a bounded tail, pages older history on demand and reuses the window when reopened', { timeout: 40_000 }, async t => {
  const h = harness(t); h.start();
  const agent = await h.spawn('STREAM');
  await waitForIdle(h.manager, agent.id);
  const logFile = h.manager.eventLogs(agent.id)[0];
  const before = fs.readFileSync(logFile);
  // An older run with more than one page of history, so the bounded tail cannot reach its first record.
  const runId = randomUUID(), runDir = path.join(path.dirname(path.dirname(logFile)), runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'request.json'), JSON.stringify({ runId, message: 'OLDER run fixture', createdAt: Date.now() - 60_000 }));
  const records = Array.from({ length: 420 }, (_, i) => JSON.stringify({ type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: `OLDER_MARKER_${String(i).padStart(3, '0')} ` + 'o'.repeat(2000) }], usage: { input: 1, output: 1, totalTokens: 2 } } }));
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), records.join('\n') + '\n');
  assert.equal(h.manager.eventLogs(agent.id).length, 2);
  h.state.scripts.push(async viewer => {
    const text = () => viewer.render(120).join('\n');
    await waitUntil('live tail frame', () => text().includes('Implementation complete'));
    assert.doesNotMatch(text(), /OLDER_MARKER_/, 'the first frame must be a bounded tail, not whole history');
    for (let i = 0; i < 12 && !/OLDER_MARKER_000 /.test(text()); i++) {
      viewer.handleInput('\u001b[H');
      await waitUntil('older page', () => text().includes('OLDER_MARKER_'));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.match(text(), /OLDER_MARKER_000 /, 'paging up reaches the first record of the older run');
    assert.match(text(), /Paused/);
    viewer.handleInput('q');
  });
  h.state.scripts.push(async viewer => {
    const text = () => viewer.render(120).join('\n');
    await waitUntil('reopened viewer', () => text().includes('OLDER_MARKER_') || text().includes('Implementation complete'));
    assert.match(text(), /OLDER_MARKER_/, 'reopening reuses the paged window instead of jumping to the latest output');
    assert.doesNotMatch(text(), /Implementation complete/);
    viewer.handleInput('\u001b[F');
    await waitUntil('End returns to the live tail', () => text().includes('Implementation complete'));
    assert.match(text(), /Following/);
    viewer.handleInput('q');
  });
  const pane = await h.openAgents();
  await pane.press(keys.enter);
  await pane.press(keys.enter);
  await pane.press(keys.escape); await pane.running;
  assert.equal(h.viewerCalls, 2, 'each open uses one viewer overlay');
  assert.deepEqual(fs.readFileSync(logFile), before, 'reading history must never rewrite the event log');
});

test('roster pane and inline messages cannot bypass managed workspace review or integration guards', { timeout: 30_000 }, async t => {
  const h = harness(t); h.start();
  const repo = path.join(h.state.cwd, 'repo'); fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true });
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'fixture');
  h.ctx.cwd = repo;
  const ws = JSON.parse(await h.invoke('subagent', { action: 'workspace_create' }));
  const worker = json(await h.invoke('subagent', { action: 'start', role: 'worker', task: 'CWD', workspace: ws.id }));
  await closeCompleted(h.manager, worker.id);
  const reviewer = json(await h.invoke('subagent', { action: 'start', role: 'reviewer', task: 'HOLD review', workspace: ws.id }));
  h.editorAnswer = 'CWD';
  const occupied = await h.openAgents();
  await occupied.press('h'); await occupied.press('i'); await occupied.press('s');
  await occupied.press(keys.escape); await occupied.running;
  assert.ok(h.notices.some(notice => /occupied/.test(notice.message)));
  assert.equal(h.manager.get(worker.id).runCount, 1);
  await h.manager.send(reviewer.id, 'review complete');
  await closeCompleted(h.manager, reviewer.id);
  fs.writeFileSync(path.join(ws.path, 'base.txt'), 'new\n');
  await h.invoke('subagent', { action: 'workspace_integrate', workspace: ws.id });
  const integrated = await h.openAgents();
  await integrated.press('h'); await integrated.press('i'); await integrated.press('s');
  await integrated.press(keys.escape); await integrated.running;
  assert.ok(h.notices.some(notice => /integrated/.test(notice.message)));
  h.state.scripts.push(async viewer => {
    await waitUntil('viewer ready', () => viewer.render(120).join('\n').includes(worker.id.slice(0, 8)));
    viewer.handleInput(keys.enter);
    for (const key of 'CWD') viewer.handleInput(key);
    viewer.handleInput(keys.enter);
    await waitUntil('inline baseline dialog after closing viewer', () => h.state.selections.length >= 2);
  });
  const inline = await h.openAgents();
  await inline.press('h'); await inline.press(keys.enter);
  await inline.press(keys.escape); await inline.running;
  assert.equal(h.manager.get(worker.id).runCount, 1);
  assert.equal(h.manager.get(worker.id).sessionId, worker.sessionId);
});

test('TUI sync requires dirty-state confirmation and inline continuation preserves the original session', { timeout: 40_000 }, async t => {
  const h = harness(t); h.start();
  const repo = path.join(h.state.cwd, 'repo'); fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'fixture');
  h.ctx.cwd = repo;
  const ws = JSON.parse(await h.invoke('subagent', { action: 'workspace_create' }));
  const worker = json(await h.invoke('subagent', { action: 'start', role: 'worker', task: 'CWD', workspace: ws.id }));
  await closeCompleted(h.manager, worker.id);
  fs.writeFileSync(path.join(ws.path, 'base.txt'), 'integrated\n'); await h.invoke('subagent', { action: 'workspace_integrate', workspace: ws.id });
  fs.writeFileSync(path.join(repo, 'parent-new.txt'), 'new parent content');
  h.state.selectAnswer = (_title, choices) => choices[1]; h.state.confirmAnswer = false; h.editorAnswer = 'CWD';
  const declined = await h.openAgents();
  await declined.press('h'); await declined.press('i'); await declined.press('s');
  await declined.press(keys.escape); await declined.running;
  assert.match(h.confirms.at(-1).message, /parent-new.txt/);
  assert.equal(h.manager.get(worker.id).runCount, 1);
  assert.equal(fs.existsSync(path.join(ws.path, 'parent-new.txt')), false, 'declining inheritance must not change the worktree');
  h.state.confirmAnswer = true;
  h.state.scripts.push(async viewer => {
    await waitUntil('viewer ready', () => viewer.render(120).join('\n').includes(worker.id.slice(0, 8)));
    viewer.handleInput(keys.enter);
    for (const key of 'CWD') viewer.handleInput(key);
    viewer.handleInput(keys.enter);
  });
  const inline = await h.openAgents();
  await inline.press('h'); await inline.press(keys.enter);
  await inline.press(keys.escape); await inline.running;
  const resumed = await waitForIdle(h.manager, worker.id);
  assert.equal(resumed.runCount, 2);
  assert.notEqual(resumed.runId, worker.runId);
  assert.equal(h.manager.get(worker.id).sessionId, worker.sessionId);
  assert.equal(fs.readFileSync(path.join(ws.path, 'parent-new.txt'), 'utf8'), 'new parent content');
  assert.equal(git('-C', ws.path, 'status', '--porcelain'), '');
  assert.ok(h.messages.some(entry => entry.message.customType === 'cli-subagents-human-action' && /workspace baseline: sync/.test(entry.message.content)));
  assert.equal(h.editors.length, 1, 'inline text is retained when the viewer closes for a baseline dialog');
});

test('TUI refuses parent changes made after the inheritance dialog was displayed', { timeout: 30_000 }, async t => {
  const h = harness(t); h.start();
  const repo = path.join(h.state.cwd, 'repo'); fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true });
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'fixture');
  h.ctx.cwd = repo;
  const ws = JSON.parse(await h.invoke('subagent', { action: 'workspace_create' }));
  const worker = json(await h.invoke('subagent', { action: 'start', role: 'worker', task: 'CWD', workspace: ws.id }));
  await closeCompleted(h.manager, worker.id);
  fs.writeFileSync(path.join(ws.path, 'base.txt'), 'integrated\n'); await h.invoke('subagent', { action: 'workspace_integrate', workspace: ws.id });
  h.state.selectAnswer = (_title, choices) => choices[1]; h.editorAnswer = 'CWD';
  h.ctx.ui.confirm = async () => { fs.writeFileSync(path.join(repo, 'unconfirmed.txt'), 'arrived during dialog'); return true; };
  const rejected = await h.openAgents();
  await rejected.press('h'); await rejected.press('i'); await rejected.press('s');
  await rejected.press(keys.escape); await rejected.running;
  assert.ok(h.notices.some(notice => /confirmed snapshot/.test(notice.message)));
  assert.equal(h.manager.get(worker.id).runCount, 1);
  assert.equal(fs.existsSync(path.join(ws.path, 'unconfirmed.txt')), false);
  assert.equal(h.manager.workspaces.get(ws.id).baseCommit, ws.baseCommit);
});

test('session shutdown dismisses a live viewer without stopping its child or reopening the roster', { timeout: 15000 }, async t => {
  const h = harness(t); h.start();
  const agent = await h.spawn('HOLD ui-lifecycle');
  h.state.scripts.push(async viewer => {
    await waitUntil('viewer initialized', () => viewer.render(120).join('\n').includes('worker'));
    h.handlers.session_shutdown();
  });
  const pane = await h.openAgents();
  await pane.press(keys.enter);
  await pane.running;
  assert.equal(h.viewerCalls, 1);
  assert.equal(h.state.customs.filter(entry => entry.roster).length, 1, 'shutdown must not reopen the roster');
  assert(h.state.customs.every(entry => !entry.active), 'shutdown dismisses every native surface');
  assert.equal(h.manager.get(agent.id).phase, 'running');
  assert.equal(processAlive(h.manager.get(agent.id).workerPid), true);
});

test('the role editor is a framed pane above the editor that owns the keyboard while open', { timeout: 20_000 }, async (t) => {
  const h = harness(t);
  h.start();
  const running = h.commands.get('cli-agents-setting').handler('', h.ctx);
  const registered = await waitUntil('role panel widget', () => h.widgetCalls.find((call) => call.key === 'cli-subagents-role-settings' && typeof call.content === 'function'));
  assert.equal(h.customCalls, 0, 'the input box stays on screen instead of being replaced by a modal overlay');
  const component = registered.content({ terminal: { rows: 35, columns: 120 }, requestRender() {} }, theme);
  const rendered = () => component.render(100).join('\n');
  assert.match(rendered(), /^╭─+╮$/m, 'the pane is framed');
  assert.match(rendered(), /Subagent roles — /);
  const press = (key) => assert.deepEqual(h.state.listeners.at(-1)(key), { consume: true }, `${key} must not reach the editor`);
  press(keys.down); press(keys.down);
  assert.match(rendered(), /› reviewer/, 'the list cursor follows the arrow keys');
  press(keys.enter);
  assert.match(rendered(), /reviewer — /, 'the highlighted role opens, not the first one');
  assert.equal(h.state.listeners.length, 1, 'only the open pane owns terminal input');
  press(keys.escape); press(keys.escape);
  await running;
  assert.equal(h.state.listeners.length, 0, 'closing the pane returns all keys to the editor');
  assert.equal(h.widgetCalls.at(-1).content, undefined, 'the pane is removed from above the editor');
  assert.deepEqual(h.notices, [], 'closing a clean panel changes nothing');
});

test('changing a value reopens that role and field instead of the top of the list', { timeout: 20_000 }, async (t) => {
  const h = harness(t);
  h.start();
  const running = h.commands.get('cli-agents-setting').handler('', h.ctx);
  const registered = await waitUntil('role panel widget', () => h.widgetCalls.filter((call) => call.key === 'cli-subagents-role-settings').at(-1));
  const component = registered.content({ terminal: { rows: 35, columns: 120 }, requestRender() {} }, theme);
  const rendered = () => component.render(100).join('\n');
  const press = async (key) => { h.state.listeners.at(-1)(key); await new Promise((resolve) => setTimeout(resolve, 20)); };
  assert.match(rendered(), /Subagent roles — /);
  await press(keys.enter);                    // open the first role
  assert.match(rendered(), /explore — /);
  await press(keys.enter);                    // open its cli picker
  assert.match(rendered(), /explore · cli/);
  await press(keys.enter);                    // apply the value
  assert.match(rendered(), /explore — /, 'the role must stay open after a change');
  assert.match(rendered(), /› cli  pi/, 'the field cursor returns to the field that changed');
  assert.doesNotMatch(rendered(), /Subagent roles —/, 'the user must not be thrown back to the top of the list');
  await press(keys.escape); await press(keys.escape);
  await running;
});

test('a refused batch release keeps the roster open and releases nothing', { timeout: 35_000 }, async (t) => {
  const h = harness(t); h.start();
  const a = await h.spawn('first result'), first = await waitForIdle(h.manager, a.id);
  const b = await h.spawn('second result'), second = await waitForIdle(h.manager, b.id);
  const pane = await h.openAgents();
  const listeners = h.state.listeners.length, notices = h.notices.length;
  h.state.confirmAnswer = false;
  await pane.press('c');
  await waitUntil('the idle batch confirmation', () => h.state.confirms.length === 1, 5_000);
  await new Promise((resolve) => setTimeout(resolve, 50));   // the refusal's next step is a short tick chain, not a race with the pane
  assert.equal(h.state.listeners.length, listeners, 'a refused batch must leave the roster owning the keyboard');
  const released = h.manager.get(a.id);
  assert.equal(released.phase, 'idle');
  assert.equal(released.runId, first.runId); assert.equal(released.runtimeId, first.runtimeId);
  assert.equal(h.manager.get(b.id).runId, second.runId);
  assert.equal(h.messages.filter((entry) => entry.message.customType === 'cli-subagents-human-action').length, 0,
    'a refused batch records no human action');
  assert.equal(h.notices.length, notices);
  await pane.press(keys.escape); await pane.running;
  assert.equal(h.state.listeners.length, 0);
});

test('a session change during a roster message stops the command without a delivery receipt', { timeout: 30_000 }, async (t) => {
  const h = harness(t); h.start();
  const agent = await h.spawn('HOLD roster message');
  await waitUntil('a running roster target', () => h.manager.get(agent.id).phase === 'running', 10_000);
  const originalSend = AgentManager.prototype.send;
  let sends = 0;
  AgentManager.prototype.send = async function (...args) {
    const result = await originalSend.apply(this, args);
    if (++sends === 1) {   // the parent switched sessions while this input request was in flight
      const savedPath = process.env.PATH; process.env.PATH = '';
      try { h.handlers.session_start({ type: 'session_start', reason: 'resume' }, h.ctx); }
      finally { if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath; }
    }
    return result;
  };
  try {
    h.editorAnswer = 'steer the running child';
    const pane = await h.openAgents();
    const notices = h.notices.length;
    await pane.press('i'); await pane.press('s');
    await pane.running;
    assert.equal(sends, 1, 'the message must have been in flight when the session changed');
    assert.equal(h.state.listeners.length, 0, 'the command must stop instead of showing the roster again');
    assert.equal(h.notices.length, notices, 'a send stopped by a session change must not report a delivery receipt');
  } finally { AgentManager.prototype.send = originalSend; }
});
