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

function harness(t) {
  const cwd = tempDir('ui-loop');
  const parent = path.join(cwd, 'parent.jsonl'); fs.writeFileSync(parent, '{}\n');
  const state = {
    cwd, parent, entries: [], messages: [], notices: [], widgetCalls: [], editors: [], confirms: [],
    scripts: [], customCalls: 0, customActive: 0, mode: 'tui', editorAnswer: '', confirmAnswer: true, listeners: [], selections: [], selectAnswer: undefined,
  };
  const ctx = {
    cwd, hasUI: true, isProjectTrusted: () => false,
    get mode() { return state.mode; },
    sessionManager: { getSessionFile: () => parent, getEntries: () => state.entries },
    ui: {
      // Pi's editor border follows the thinking level; the viewer reuses it for its frame.
      theme: { getThinkingBorderColor: () => (text) => text, fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text },
      notify(message, type) { state.notices.push({ message, type }); },
      setStatus() {},
      setWidget(key, content, options) { state.widgetCalls.push({ key, content, options }); },
      onTerminalInput(listener) { state.listeners.push(listener); return () => { state.listeners.splice(state.listeners.indexOf(listener), 1); }; },
      getEditorText() { return ''; },
      custom(factory) {
        state.customCalls += 1; state.customActive += 1;
        return new Promise((resolve, reject) => {
          let settled = false;
          const done = (result) => { if (!settled) { settled = true; state.customActive -= 1; resolve(result); } };
          const component = factory({ terminal: { columns: 120, rows: 35 }, requestRender() {} }, theme, {}, done);
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
    /**
     * The roster is a pane above the editor like the role editor, so it has no custom() overlay:
     * keys go through its terminal-input listener, and only the conversation viewer is modal.
     * A key is only accepted while the pane owns the keyboard, so presses retry around actions
     * that open a host dialog or the viewer.
     */
    async openAgents({ shortcut = false } = {}) {
      const before = state.widgetCalls.length;
      const running = shortcut ? shortcuts.get('ctrl+alt+a').handler(ctx) : commands.get('agents').handler('', ctx);
      const registered = await waitUntil('agents pane widget', () => state.widgetCalls.slice(before)
        .find(call => call.key === 'cli-subagents-agents' && typeof call.content === 'function'));
      const component = registered.content({ terminal: { rows: 35, columns: 120 }, requestRender() {} }, theme);
      const press = (key) => waitUntil(`the agents pane to accept ${JSON.stringify(key)}`, () => state.listeners.at(-1)(key));
      return { running, render: (width = 100) => component.render(width).join('\n'), press };
    },
  };
}

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
    // This synthetic record has no protocolVersion: legacy completion stays readable.
    phase = 'completed'; t.mock.timers.tick(200);
    assert.equal(calls, 2);
    assert.ok(components.every(component => /completed/i.test(component.render(120).join('\n'))));
  } finally {
    h.handlers.session_shutdown?.(); t.mock.timers.reset(); AgentManager.prototype.list = original;
  }
});

test('status widget registers only in TUI, shows agents and unregisters at shutdown', { timeout: 20_000 }, async (t) => {
  const h = harness(t);
  h.start();
  const agent = await h.spawn('REMEMBER widget');
  const idle = await waitForIdle(h.manager, agent.id);
  assert.equal(idle.protocolVersion, 2);
  assert.equal(processAlive(idle.workerPid), true, 'run completion must leave the worker resident');
  assert.ok(fs.existsSync(path.join(h.manager.root, agent.id, 'owner.lock')));
  const registered = await waitUntil('widget registration', () => h.widgetCalls.find((call) => typeof call.content === 'function'));
  assert.equal(registered.key, 'cli-subagents');
  const component = registered.content({ terminal: { columns: 120 }, requestRender() {} }, theme);
  const rendered = () => component.render(120).join('\n');
  assert.match(rendered(), /worker/, 'widget must show the role');
  assert.match(rendered(), /\d+\.\d+s/, 'widget must show elapsed time');
  // A finished run collapses to one idle row; the owner is still available for release.
  await waitUntil('widget reflects idle completion', () => /Idle.*last Completed/.test(rendered()));
  assert.match(rendered(), /└─ ○ worker/);
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
  assert.equal(h.customCalls, 0, 'the roster replaces neither the input box nor the transcript');
  assert.match(h.editors[0], /Resume worker/);
  assert.equal(h.widgetCalls.filter(call => call.key === 'cli-subagents-agents').at(-1).content, undefined, 'the pane is removed from above the editor');
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
  assert.equal(human.length, 2); assert(human.every(entry => entry.options.triggerTurn === false));
  assert.equal(human.find(entry => entry.message.details.agentId === a.id).message.details.runId, first.runId);
  assert.match(human.find(entry => entry.message.details.agentId === a.id).message.content, /unconfirmed/i);
  assert.match(human.find(entry => entry.message.details.agentId === b.id).message.content, /Native processes released/);
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
  for (const mode of ['tui', 'rpc']) {
    h.mode = mode;
    const child = await manager.spawn('codex-worker', { cli: 'codex', model: 'gpt-6-luna', description: 'fixture', instructions: 'test' }, h.state.cwd, 'APPROVAL_ACCEPT_CANCEL');
    const q = await waitUntil('Codex choice', () => manager.get(child.id).questions[0]);
    h.state.selectAnswer = 'Cancel turn';
    await h.commands.get('agent-reply').handler(`${child.id} ${q.id}`, h.ctx);
    const dialog = h.state.selections.at(-1);
    assert.match(dialog.title, /Command: write fixture-only/); assert.match(dialog.title, /Directory:/);
    assert.match(dialog.title, /Cancel turn ends this turn/); assert.deepEqual(dialog.options, ['Approve once', 'Cancel turn']);
    const cancelled = await waitForIdle(manager, child.id, 'stopped');
    assert.equal(processAlive(cancelled.workerPid), true, 'Cancel turn must not close the resident runtime');
    assert.ok(fs.existsSync(path.join(manager.root, child.id, 'owner.lock')));
    assert.ok(h.messages.some(e => e.message.customType === 'cli-subagents-human-action' && e.message.content.includes('Cancel turn')));
  }
  assert.equal(h.confirms.length, 0, 'no boolean dialog may hide cancel-vs-decline semantics');
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
  assert.equal(h.customCalls, 1, 'the shortcut opens the roster pane, and only the viewer is an overlay');
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
  assert.equal(h.customCalls, 1, 'closing the viewer returns to the pane instead of a second overlay');
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
  assert.equal(h.customCalls, 2, 'each open uses one viewer overlay');
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
  assert.equal(h.customCalls, 1, 'shutdown must not reopen the roster');
  assert.equal(h.widgetCalls.filter(call => call.key === 'cli-subagents-agents').at(-1).content, undefined, 'the pane is removed at shutdown');
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
