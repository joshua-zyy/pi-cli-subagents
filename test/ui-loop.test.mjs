// Integration checks: TUI widget lifecycle and panel actions through the real manager.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import extension from '../dist/index.js';
import { waitUntil, processAlive } from '../dist/storage.js';
import { AgentManager } from '../dist/manager.js';
import { Editor } from '@earendil-works/pi-tui';

const fixture = fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url));
const root = path.resolve('.test-output'); fs.mkdirSync(root, { recursive: true });
const theme = { fg: (_color, text) => text, bold: (text) => text };
const keys = { up: '\u001b[A', down: '\u001b[B', enter: '\r', escape: '\u001b' };
const json = (text) => JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));

function harness(t) {
  const cwd = fs.mkdtempSync(path.join(root, 'ui-loop-'));
  const parent = path.join(cwd, 'parent.jsonl'); fs.writeFileSync(parent, '{}\n');
  const state = {
    cwd, parent, entries: [], messages: [], notices: [], widgetCalls: [], editors: [], confirms: [],
    scripts: [], customCalls: 0, mode: 'tui', editorAnswer: '', confirmAnswer: true, listeners: [],
  };
  const ctx = {
    cwd, hasUI: true, isProjectTrusted: () => false,
    get mode() { return state.mode; },
    sessionManager: { getSessionFile: () => parent, getEntries: () => state.entries },
    ui: {
      // Pi's editor border follows the thinking level; the viewer reuses it for its frame.
      theme: { getThinkingBorderColor: () => (text) => text, fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text },
      notify(message, type) { state.notices.push({ message, type }); },
      setWidget(key, content, options) { state.widgetCalls.push({ key, content, options }); },
      onTerminalInput(listener) { state.listeners.push(listener); return () => { state.listeners.splice(state.listeners.indexOf(listener), 1); }; },
      getEditorText() { return ''; },
      custom(factory) {
        state.customCalls += 1;
        return new Promise((resolve, reject) => {
          let settled = false;
          const done = (result) => { if (!settled) { settled = true; resolve(result); } };
          const component = factory({ terminal: { columns: 120, rows: 35 }, requestRender() {} }, theme, {}, done);
          const script = state.scripts.shift() ?? [];
          if (typeof script === 'function') { Promise.resolve(script(component, done)).catch(reject); return; }
          for (const key of script) component.handleInput(key);
          if (!settled) done(undefined);
        });
      },
      async editor(title) { state.editors.push(title); return state.editorAnswer; },
      async confirm(title, message) { state.confirms.push({ title, message }); return state.confirmAnswer; },
      async select() { return undefined; },
      async input() { return undefined; },
    },
  };
  const handlers = {}, tools = new Map(), commands = new Map(), shortcuts = new Map();
  const pi = {
    on(name, handler) { handlers[name] = handler; },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    registerShortcut(key, shortcut) { shortcuts.set(key, shortcut); },
    sendMessage(message, options) { state.messages.push({ message, options }); state.entries.push({ type: 'custom_message', ...message }); },
  };
  const manager = new AgentManager(parent, { command: process.execPath, args: [fixture] });
  // Replace the child Pi entry with the deterministic fixture, as in extension.test.mjs.
  const savedArgv = process.argv[1];
  process.argv[1] = fixture;
  t.after(async () => {
    handlers.session_shutdown?.();
    for (const agent of manager.list()) if (processAlive(agent.workerPid)) await manager.close(agent.id);
    process.argv[1] = savedArgv;
  });
  return {
    // Getters keep test observations live instead of returning stale primitive snapshots.
    state, ctx, pi, handlers, tools, commands, shortcuts, manager,
    get customCalls() { return state.customCalls; },
    get messages() { return state.messages; },
    get notices() { return state.notices; },
    get widgetCalls() { return state.widgetCalls; },
    get editors() { return state.editors; },
    get confirms() { return state.confirms; },
    get editorAnswer() { return state.editorAnswer; },
    set editorAnswer(value) { state.editorAnswer = value; },
    set mode(value) { state.mode = value; },
    start() { extension(pi); handlers.session_start({ type: 'session_start', reason: 'startup' }, ctx); },
    async invoke(tool, params) {
      return (await tools.get(tool).execute('id', params, undefined, undefined, ctx)).content[0].text;
    },
    async spawn(task, role = 'worker') {
      return json(await this.invoke('spawn_agent', { role, task, cwd }));
    },
    async panel(script) {
      state.scripts.push(...script);
      await commands.get('agents').handler('', ctx);
    },
  };
}

test('status widget registers only in TUI, shows agents and unregisters at shutdown', { timeout: 20_000 }, async (t) => {
  const h = harness(t);
  h.start();
  const agent = await h.spawn('REMEMBER widget');
  await waitUntil('completed', () => h.manager.get(agent.id).phase === 'completed' && !processAlive(h.manager.get(agent.id).workerPid));
  const registered = await waitUntil('widget registration', () => h.widgetCalls.find((call) => typeof call.content === 'function'));
  assert.equal(registered.key, 'cli-subagents');
  const component = registered.content({ terminal: { columns: 120 }, requestRender() {} }, theme);
  const rendered = () => component.render(120).join('\n');
  assert.match(rendered(), /worker/, 'widget must show the role');
  assert.match(rendered(), /\d+\.\d+s/, 'widget must show elapsed time');
  // Wait for the periodic snapshot refresh to collapse the finished instance.
  await waitUntil('widget reflects completion', () => rendered().includes('Completed'));
  assert.match(rendered(), /└─ ✓ worker/);
  component.invalidate();
  h.handlers.session_shutdown?.();
  for (const key of ['cli-subagents','cli-subagents-fleet']) {
    const last = h.widgetCalls.filter(call=>call.key===key).at(-1);
    assert.equal(last.content, undefined, `parent shutdown must unregister ${key}`);
  }
  assert.equal(h.state.listeners.length,0,'shutdown must unsubscribe FleetView input');
});

test('panel resumes the original session, confirms stops, and rejects non-TUI use', { timeout: 30_000 }, async (t) => {
  const h = harness(t);
  h.start();
  const agent = await h.spawn('REMEMBER panel-token');
  await waitUntil('first completion', () => h.manager.get(agent.id).phase === 'completed');
  const sessionId = h.manager.get(agent.id).sessionId;
  const firstRun = h.manager.get(agent.id).runId;

  // Open details, send through the editor, then close the restored list.
  h.editorAnswer = 'RECALL';
  await h.panel([['i', 's'], [keys.escape]]);
  assert.equal(h.customCalls, 2, 'each action reopens the list until Esc closes it');
  assert.match(h.editors[0], /Resume worker/);
  await waitUntil('resumed report', () => h.messages.some((entry) => entry.message.content.includes('panel-token')));
  assert.equal(h.manager.get(agent.id).sessionId, sessionId, 'resume must retain the original session');
  assert.notEqual(h.manager.get(agent.id).runId, firstRun);

  // HOLD is second by start time; stopping an active child needs confirmation.
  const holding = await h.spawn('HOLD');
  await waitUntil('running', () => h.manager.get(holding.id).phase === 'running');
  await h.panel([[keys.down, 'i', 'x'], [keys.escape]]);
  assert.equal(h.confirms.length, 1);
  assert.match(h.confirms[0].title, /Stop/);
  assert.equal(h.manager.get(holding.id).phase, 'stopped');
  assert.equal(h.manager.get(agent.id).phase, 'completed', 'only the selected child is stopped');
  assert.equal(processAlive(h.manager.get(holding.id).workerPid), false);

  // Non-TUI clients do not open a panel.
  h.mode = 'rpc';
  const before = h.customCalls;
  await commands0(h);
  assert.equal(h.customCalls, before);
  assert.equal(h.notices.at(-1).type, 'error');
  assert.match(h.notices.at(-1).message, /TUI/);
});

function commands0(h) { return h.commands.get('agents').handler('', h.ctx); }

test('shortcut selects a running child and opens its live conversation directly', { timeout: 15000 }, async t => {
  const h = harness(t); h.start();
  assert.ok(h.shortcuts.has('ctrl+alt+a'));
  const first = await h.spawn('HOLD one');
  const second = await h.spawn('HOLD two');
  await waitUntil('both active', () => h.manager.get(first.id).phase === 'running' && h.manager.get(second.id).phase === 'running');
  h.state.scripts.push([keys.down, keys.enter], async viewer => {
    await waitUntil('selected agent loaded', () => viewer.render(100).join('\n').includes(second.id.slice(0,8)));
    assert.match(viewer.render(100).join('\n'), /HOLD two/);
    viewer.handleInput('q');
  }, [keys.escape]);
  await h.shortcuts.get('ctrl+alt+a').handler(h.ctx);
  assert.equal(h.customCalls,3);
  assert.equal(h.manager.get(first.id).phase,'running');
  assert.equal(h.manager.get(second.id).phase,'running');
});

test('below-editor FleetView opens the selected active child without an intermediate panel', {timeout:15000},async t=>{
  const h=harness(t);h.start();
  const first=await h.spawn('HOLD fleet-one'),second=await h.spawn('HOLD fleet-two');
  const entry=await waitUntil('fleet registered',()=>h.widgetCalls.find(call=>call.key==='cli-subagents-fleet'&&typeof call.content==='function'));
  const editor=Object.create(Editor.prototype);let focus=editor;
  const tui={terminal:{columns:120},getFocusedComponent:()=>focus,requestRender(){}};
  const widget=entry.content(tui,theme);
  // The roster refreshes on the extension's monitor interval; wait for both children before keying.
  await waitUntil('fleet lists both children',()=>widget.render(120).join('\n').includes('HOLD fleet-two'));
  const key=h.state.listeners[0];assert.equal(typeof key,'function');
  focus={};assert.equal(key(keys.down),undefined,'a modal must retain input');
  focus=editor;assert.deepEqual(key(keys.down),{consume:true});
  key(keys.down);key(keys.down);
  assert.match(widget.render(120).join('\n'),/● ● worker.*HOLD fleet-two/);
  let loaded=false;
  h.state.scripts.push(async viewer=>{
    await waitUntil('selected child in viewer',()=>viewer.render(120).join('\n').includes(second.id.slice(0,8)));
    loaded=true;viewer.handleInput('q');
  });
  assert.deepEqual(key(keys.enter),{consume:true});
  await waitUntil('viewer closed',()=>loaded);
  assert.equal(h.customCalls,1,'FleetView must not open /agents summary first');
  assert.equal(h.manager.get(first.id).phase,'running');assert.equal(h.manager.get(second.id).phase,'running');
});

test('inline message from the viewer reaches the running child in the same session', {timeout:20000}, async t => {
  const h=harness(t);h.start();
  const agent=await h.spawn('HOLD inline');
  await waitUntil('running',()=>h.manager.get(agent.id).phase==='running');
  const sessionId=h.manager.get(agent.id).sessionId;
  await h.panel([[keys.enter],async viewer=>{
    await waitUntil('viewer ready',()=>viewer.render(120).join('\n').includes('HOLD inline')||viewer.render(120).join('\n').includes('worker'));
    viewer.handleInput('\r'); // open the inline composer
    for(const key of 'PING') viewer.handleInput(key);
    viewer.handleInput('\r');
    await waitUntil('child finished with the steer text',()=>h.manager.get(agent.id).phase==='completed');
    assert.equal(h.manager.get(agent.id).sessionId,sessionId,'steering must stay in the original session');
    assert.equal(h.manager.get(agent.id).text,'PING');
    viewer.handleInput('q');
  }]);
  assert.equal(h.editors.length,0,'inline send must not open the external editor dialog');
});

test('conversation is wired to live worker logs and remains open after completion', { timeout: 15000 }, async t => {
  const h = harness(t); h.start();
  const agent = await h.spawn('STREAM');
  await h.panel([[keys.enter], async viewer => {
    const text = () => viewer.render(120).join('\n');
    await waitUntil('streaming tool details', () => text().includes('partial fixture output'));
    assert.match(text(), /src\/example.ts/);
    await waitUntil('final tool output', () => text().includes('final fixture output'));
    await waitUntil('child completed', () => h.manager.get(agent.id).phase === 'completed');
    assert.match(text(), /Implementation complete/);
    viewer.handleInput('q');
  }, [keys.escape]]);
  assert.equal(h.customCalls, 3);
  assert.equal(h.manager.get(agent.id).phase, 'completed');
  assert.equal(h.manager.eventLogs(agent.id).length, 1);
  assert.throws(() => h.manager.eventLogs('foreign'), /id/);
});

test('session shutdown dismisses a live viewer without stopping its child or reopening the list', { timeout: 15000 }, async t => {
  const h = harness(t); h.start();
  const agent = await h.spawn('HOLD ui-lifecycle');
  await h.panel([[keys.enter], async viewer => {
    await waitUntil('viewer initialized', () => viewer.render(120).join('\n').includes('worker'));
    h.handlers.session_shutdown();
  }]);
  assert.equal(h.customCalls, 2);
  assert.equal(h.manager.get(agent.id).phase, 'running');
  assert.equal(processAlive(h.manager.get(agent.id).workerPid), true);
});
