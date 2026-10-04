import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import extension, { inheritParentModel } from '../dist/index.js';
import { waitUntil, processAlive } from '../dist/storage.js';
import { AgentManager } from '../dist/manager.js';

const fixture = fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url));
const root = path.resolve('.test-output'); fs.mkdirSync(root, { recursive: true });

// Three two-second report windows plus multiple Git pipelines make 20 seconds
// too small for this aggregate workflow under parallel Windows load. Transport
// and shutdown deadlines are asserted separately; this is not a per-operation timeout.
test('extension tools implement → separate review → resume same implementer; report only to original parent', { timeout: 45_000 }, async (t) => {
  const savedArgv = process.argv[1];
  process.argv[1] = fixture;
  const cwd = fs.mkdtempSync(path.join(root, 'extension-'));
  const parent = path.join(cwd, 'parent.jsonl'); fs.writeFileSync(parent, '{}\n');
  const otherParent = path.join(cwd, 'other.jsonl'); fs.writeFileSync(otherParent, '{}\n');
  let currentFile = parent;
  const entries = [];
  const ctx = {
    cwd, hasUI: true, isProjectTrusted: () => false,
    sessionManager: { getSessionFile: () => currentFile, getEntries: () => entries },
    ui: { notify() {} },
  };
  const handlers = {}, tools = new Map(), messages = [], commands = new Map();
  const pi = {
    on(name, handler) { handlers[name] = handler; },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    registerShortcut() {},
    registerMessageRenderer() {},
    sendMessage(message, options) {
      messages.push({ message, options });
      entries.push({ type: 'custom_message', ...message });
    },
  };
  const manager = new AgentManager(parent, { command: process.execPath, args: [fixture] });
  t.after(async () => {
    handlers.session_shutdown?.();
    for (const state of manager.list()) {
      if (processAlive(state.workerPid)) await manager.close(state.id);
    }
    process.argv[1] = savedArgv;
  });
  extension(pi);
  assert.deepEqual([...tools.keys()], ['subagent_workspace', 'subagent', 'subagent_query', 'subagent_reply']);
  assert.ok(commands.has('agent-reply')); assert.ok(commands.has('cli-agents-setting'));
  handlers.session_start({ type: 'session_start', reason: 'startup' }, ctx);
  const invoke = async (tool, params) => (await tools.get(tool).execute('id', params, undefined, undefined, ctx)).content[0].text;
  const spawn = JSON.parse((await invoke('subagent', { action: 'start', role: 'worker', task: 'REMEMBER unique', cwd })).match(/\{.+\}/)[0]);
  assert.ok(spawn.id); assert.equal(spawn.role, 'worker');
  await waitUntil('report', () => manager.get(spawn.id).phase === 'completed' && !processAlive(manager.get(spawn.id).workerPid));
  currentFile = otherParent;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(messages.length, 0, 'never deliver reports into unrelated parent session');
  handlers.session_shutdown?.();
  currentFile = parent;
  handlers.session_start({ type: 'session_start', reason: 'resume' }, ctx);
  await waitUntil('delivered after parent returns', () => messages.length === 1);
  assert.equal(messages[0].message.details.ids.length, 1);
  assert.equal(messages[0].options.deliverAs, 'steer');
  const id = spawn.id;
  const listed = JSON.parse(await invoke('subagent_query', { action: 'get', id }));
  assert.equal(listed.agents[0].id, id);
  assert.equal(listed.agents[0].task, 'REMEMBER unique', 'the parent must see which task an instance is running');
  assert.equal(typeof listed.agents[0].startedAt, 'number', 'the parent needs a start time to reason about elapsed work');
  assert.deepEqual(Object.keys(listed.roles), ['explore', 'worker', 'reviewer', 'oracle'], 'role discovery must include investigation and consultation');
  assert.deepEqual(listed.agents[0].history.map((run) => run.task), ['REMEMBER unique']);
  assert.equal(listed.agents[0].runCount, 1);
  const reviewer = JSON.parse((await invoke('subagent', { action: 'start', role: 'reviewer', task: 'REVIEW: return issue for worker', cwd })).match(/\{.+\}/)[0]);
  await waitUntil('review report', () => manager.reports().length === 2);
  await waitUntil('review delivered', () => messages.length === 2);
  assert.match(messages[1].message.content, /REVIEW/);
  assert.notEqual(manager.get(reviewer.id).sessionId, manager.get(id).sessionId);
  assert.equal(manager.get(reviewer.id).cwd, manager.get(id).cwd);
  const originalSession = manager.get(id).sessionId;
  await invoke('subagent', { action: 'send', id, message: 'RECALL' });
  await waitUntil('resumed report', () => manager.reports().length === 3);
  await waitUntil('resumed delivery', () => messages.length === 3);
  assert.match(messages[2].message.content, /unique/);
  assert.equal(manager.get(id).sessionId, originalSession);
  assert.equal(manager.list().length, 2);
  // After the parent's own context is compacted, history is how it recalls who did what.
  const recovered = JSON.parse(await invoke('subagent_query', { action: 'list' })).agents.find((agent) => agent.id === id);
  assert.deepEqual(recovered.history.map((run) => run.task), ['REMEMBER unique', 'RECALL']);
  assert.deepEqual(recovered.history.map((run) => run.status), ['completed', 'completed']);
  assert.equal(recovered.runCount, 2);

  const repo = path.join(cwd, 'repo'); fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true });
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'fixture');
  ctx.cwd = repo;
  const ws = JSON.parse(await invoke('subagent_workspace', { action: 'create' }));
  await assert.rejects(invoke('subagent', { action: 'start', role: 'worker', task: 'CWD', workspace: ws.id, cwd: repo }), /workspace.*cwd|cwd.*workspace/);
  const managed = JSON.parse((await invoke('subagent', { action: 'start', role: 'worker', task: 'CWD', workspace: ws.id })).match(/\{.+\}/)[0]);
  await waitUntil('managed completion', () => manager.get(managed.id).phase === 'completed' && !processAlive(manager.get(managed.id).workerPid));
  assert.equal(managed.workspace, ws.id);
  assert.equal(manager.get(managed.id).text, ws.cwd);
  const withWorkspaces = JSON.parse(await invoke('subagent_query', { action: 'get', id: managed.id }));
  assert.equal(withWorkspaces.workspaces.length, 1);
  assert.equal(withWorkspaces.agents[0].workspace, ws.id);
  fs.writeFileSync(path.join(ws.path, 'added.txt'), 'managed\n');
  assert.equal(JSON.parse(await invoke('subagent_workspace', { action: 'integrate', workspace: ws.id })).status, 'applied');
  assert.equal(fs.readFileSync(path.join(repo, 'added.txt'), 'utf8'), 'managed\n');
  await assert.rejects(invoke('subagent', { action: 'send', id: managed.id, message: 'CWD' }), /integrat/i);
  const inherited = JSON.parse(await invoke('subagent_workspace', { action: 'create', includeUncommitted: { reason: 'The user approved inheriting added.txt.' } }));
  assert.equal(inherited.snapshotReason, 'The user approved inheriting added.txt.');
  assert.equal(fs.readFileSync(path.join(inherited.path, 'added.txt'), 'utf8'), 'managed\n');
  await invoke('subagent', { action: 'send', id: managed.id, message: 'CWD', baseline: 'sync', includeUncommitted: { reason: 'The user approved the parent changes for sync.' } });
  await waitUntil('synced continuation completed', () => manager.get(managed.id).runCount === 2 && manager.get(managed.id).phase === 'completed' && !processAlive(manager.get(managed.id).workerPid));
  assert.equal(manager.get(managed.id).sessionId, managed.sessionId);
  const syncedView = JSON.parse(await invoke('subagent_query', { action: 'get', id: managed.id })).agents[0];
  assert.equal(syncedView.workspaceBaseline.commit, manager.workspaces.get(ws.id).baseCommit);
});

test('the role editor is registered but stays out of non-TUI modes', async () => {
  const commands = new Map(), notifications = [];
  extension({ on() {}, registerTool() {}, registerCommand: (name, command) => commands.set(name, command), registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {} });
  const ctx = { mode: 'rpc', cwd: process.cwd(), isProjectTrusted: () => true, ui: { notify: (message, level) => notifications.push([message, level]) } };
  await commands.get('cli-agents-setting').handler('', ctx);
  assert.deepEqual(notifications.map(([, level]) => level), ['error']);
  assert.match(notifications[0][0], /TUI/);
});

test('a Pi role without an explicit model follows the parent session', () => {
  const role = { description: 'do work', instructions: 'Only the assigned work' };
  const model = { id: 'claude-opus-5[1M]', provider: 'anthropic' };
  assert.deepEqual(inheritParentModel(role, { model, thinkingLevel: 'max' }), { ...role, provider: 'anthropic', model: 'claude-opus-5[1M]', thinking: 'max' });
  assert.deepEqual(inheritParentModel({ ...role, model: 'chosen', thinking: 'off' }, { model, thinkingLevel: 'max' }),
    { ...role, model: 'chosen', provider: 'anthropic', thinking: 'off' }, 'an explicit field is never overridden');
  assert.deepEqual(inheritParentModel(role, { model: undefined, thinkingLevel: undefined }), role, 'no parent choice leaves the role untouched');
  assert.deepEqual(inheritParentModel({ ...role, cli: 'codex', model: 'gpt-6-luna' }, { model, thinkingLevel: 'max' }),
    { ...role, cli: 'codex', model: 'gpt-6-luna' }, 'Codex and Claude roles are never rewritten');
});
