import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import extension from '../dist/index.js';
import { waitUntil, processAlive } from '../dist/storage.js';
import { AgentManager } from '../dist/manager.js';

const fixture = fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url));
const root = path.resolve('.test-output'); fs.mkdirSync(root, { recursive: true });

test('extension tools implement → separate review → resume same implementer; report only to original parent', { timeout: 20_000 }, async (t) => {
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
  assert.deepEqual([...tools.keys()], ['spawn_agent', 'send_input', 'list_agents', 'close_agent']);
  assert.ok(commands.has('agent-reply'));
  handlers.session_start({ type: 'session_start', reason: 'startup' }, ctx);
  const invoke = async (tool, params) => (await tools.get(tool).execute('id', params, undefined, undefined, ctx)).content[0].text;
  const spawn = JSON.parse((await invoke('spawn_agent', { role: 'worker', task: 'REMEMBER unique', cwd })).match(/\{.+\}/)[0]);
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
  assert.equal(messages[0].options.deliverAs, 'followUp');
  const id = spawn.id;
  assert.equal(JSON.parse(await invoke('list_agents', { id })).agents[0].id, id);
  const reviewer = JSON.parse((await invoke('spawn_agent', { role: 'reviewer', task: 'REVIEW: return issue for worker', cwd })).match(/\{.+\}/)[0]);
  await waitUntil('review report', () => manager.reports().length === 2);
  await waitUntil('review delivered', () => messages.length === 2);
  assert.match(messages[1].message.content, /REVIEW/);
  assert.notEqual(manager.get(reviewer.id).sessionId, manager.get(id).sessionId);
  assert.equal(manager.get(reviewer.id).cwd, manager.get(id).cwd);
  const originalSession = manager.get(id).sessionId;
  await invoke('send_input', { id, message: 'RECALL' });
  await waitUntil('resumed report', () => manager.reports().length === 3);
  await waitUntil('resumed delivery', () => messages.length === 3);
  assert.match(messages[2].message.content, /unique/);
  assert.equal(manager.get(id).sessionId, originalSession);
  assert.equal(manager.list().length, 2);
});
