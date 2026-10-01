// Integration checks: TUI widget lifecycle and panel actions through the real manager.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
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

test('one monitor tick shares one live snapshot across reports, status and fleet', t => {
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
    assert.equal(calls, 1, 'report delivery and both widgets must share one manager list');
    const components = h.widgetCalls.filter(call => typeof call.content === 'function')
      .map(call => call.content({ terminal: { columns: 120 }, requestRender() {} }, theme));
    assert.equal(components.length, 2);
    t.mock.timers.tick(500);
    assert.equal(calls, 1, 'animation between monitor ticks must not read another snapshot');
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

test('direct human actions are recorded for the parent without interrupting it', { timeout: 30_000 }, async (t) => {
  const h = harness(t);
  h.start();
  const holding = await h.spawn('HOLD human-sync');
  await waitUntil('running', () => h.manager.get(holding.id).phase === 'running');
  const human = () => h.messages.filter((entry) => entry.message.customType === 'cli-subagents-human-action');

  // A routine instruction: the parent must see it, but sibling work must not be interrupted.
  h.editorAnswer = 'HOLD and also check the docs';
  await h.panel([['i', 's'], [keys.escape]]);
  await waitUntil('instruction recorded', () => human().length === 1);
  assert.equal(human()[0].options.triggerTurn, false);
  assert.match(human()[0].message.content, new RegExp(holding.id));
  assert.match(human()[0].message.content, /worker\] Sent an instruction: "HOLD and also check the docs"/);
  assert.match(human()[0].message.content, /does not widen the task's original authorization/);
  assert.equal(human()[0].message.details.agentId, holding.id);
  assert.equal(human()[0].message.details.ids, undefined, 'human entries must not count as report receipts');
  assert.equal(h.manager.get(holding.id).phase, 'running', 'steering must not end the run');

  // A human permission decision is the most consequential direct action.
  const asking = await h.spawn('WAIT');
  await waitUntil('waiting', () => h.manager.get(asking.id).phase === 'waiting');
  await h.panel([[keys.down, 'i', 'r'], [keys.escape]]);
  await waitUntil('decision recorded', () => human().length === 2);
  assert.match(human()[1].message.content, new RegExp(`${asking.id}.*worker\\] Answered pending request permission-1: approved once`, 's'));

  // Stopping a child changes the plan the parent is coordinating.
  await h.panel([['i', 'x'], [keys.escape]]);
  await waitUntil('stop recorded', () => human().length === 3);
  assert.match(human()[2].message.content, new RegExp(`${holding.id}.*Stopped active work`, 's'));
  assert.equal(h.manager.get(holding.id).phase, 'stopped');

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
    await waitUntil('cancelled native task', () => manager.get(child.id).phase === 'stopped');
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

test('panel and inline messages cannot bypass managed workspace review or integration guards', { timeout: 30_000 }, async t => {
  const h = harness(t); h.start();
  const repo = path.join(h.state.cwd, 'repo'); fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true });
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'fixture');
  h.ctx.cwd = repo;
  const ws = JSON.parse(await h.invoke('create_workspace', {}));
  const worker = json(await h.invoke('spawn_agent', { role: 'worker', task: 'CWD', workspace: ws.id }));
  await waitUntil('worker released', () => h.manager.get(worker.id).phase === 'completed' && !processAlive(h.manager.get(worker.id).workerPid));
  const reviewer = json(await h.invoke('spawn_agent', { role: 'reviewer', task: 'HOLD review', workspace: ws.id }));
  h.editorAnswer = 'CWD';
  await h.panel([['i', 's'], [keys.escape]]);
  assert.ok(h.notices.some(notice => /occupied/.test(notice.message)));
  assert.equal(h.manager.get(worker.id).runCount, 1);
  await h.manager.send(reviewer.id, 'review complete');
  await waitUntil('reviewer released', () => h.manager.get(reviewer.id).phase === 'completed' && !processAlive(h.manager.get(reviewer.id).workerPid));
  fs.writeFileSync(path.join(ws.path, 'base.txt'), 'new\n');
  await h.invoke('integrate_workspace', { workspace: ws.id });
  await h.panel([['i', 's'], [keys.escape]]);
  assert.ok(h.notices.some(notice => /integrated/.test(notice.message)));
  await h.panel([[keys.enter], async viewer => {
    await waitUntil('viewer ready', () => viewer.render(120).join('\n').includes(worker.id.slice(0, 8)));
    viewer.handleInput(keys.enter);
    for (const key of 'CWD') viewer.handleInput(key);
    viewer.handleInput(keys.enter);
    await waitUntil('inline baseline dialog after closing viewer', () => h.state.selections.length >= 2);
  }, [keys.escape]]);
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
  const ws = JSON.parse(await h.invoke('create_workspace', {}));
  const worker = json(await h.invoke('spawn_agent', { role: 'worker', task: 'CWD', workspace: ws.id }));
  await waitUntil('worker released', () => h.manager.get(worker.id).phase === 'completed' && !processAlive(h.manager.get(worker.id).workerPid));
  fs.writeFileSync(path.join(ws.path, 'base.txt'), 'integrated\n'); await h.invoke('integrate_workspace', { workspace: ws.id });
  fs.writeFileSync(path.join(repo, 'parent-new.txt'), 'new parent content');
  h.state.selectAnswer = (_title, choices) => choices[1]; h.state.confirmAnswer = false; h.editorAnswer = 'CWD';
  await h.panel([['i', 's'], [keys.escape]]);
  assert.match(h.confirms.at(-1).message, /parent-new.txt/);
  assert.equal(h.manager.get(worker.id).runCount, 1);
  assert.equal(fs.existsSync(path.join(ws.path, 'parent-new.txt')), false, 'declining inheritance must not change the worktree');
  h.state.confirmAnswer = true;
  await h.panel([[keys.enter], async viewer => {
    await waitUntil('viewer ready', () => viewer.render(120).join('\n').includes(worker.id.slice(0, 8)));
    viewer.handleInput(keys.enter);
    for (const key of 'CWD') viewer.handleInput(key);
    viewer.handleInput(keys.enter);
  }, [keys.escape]]);
  await waitUntil('resumed instance completed', () => h.manager.get(worker.id).runCount === 2 && h.manager.get(worker.id).phase === 'completed' && !processAlive(h.manager.get(worker.id).workerPid));
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
  const ws = JSON.parse(await h.invoke('create_workspace', {}));
  const worker = json(await h.invoke('spawn_agent', { role: 'worker', task: 'CWD', workspace: ws.id }));
  await waitUntil('worker released', () => h.manager.get(worker.id).phase === 'completed' && !processAlive(h.manager.get(worker.id).workerPid));
  fs.writeFileSync(path.join(ws.path, 'base.txt'), 'integrated\n'); await h.invoke('integrate_workspace', { workspace: ws.id });
  h.state.selectAnswer = (_title, choices) => choices[1]; h.editorAnswer = 'CWD';
  h.ctx.ui.confirm = async () => { fs.writeFileSync(path.join(repo, 'unconfirmed.txt'), 'arrived during dialog'); return true; };
  await h.panel([['i', 's'], [keys.escape]]);
  assert.ok(h.notices.some(notice => /confirmed snapshot/.test(notice.message)));
  assert.equal(h.manager.get(worker.id).runCount, 1);
  assert.equal(fs.existsSync(path.join(ws.path, 'unconfirmed.txt')), false);
  assert.equal(h.manager.workspaces.get(ws.id).baseCommit, ws.baseCommit);
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
