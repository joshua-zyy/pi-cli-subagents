import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import extension from '../dist/index.js';
import { AgentManager } from '../dist/manager.js';
import { WorkspaceStore } from '../dist/workspace.js';

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'role-catalog-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'project');
  fs.mkdirSync(home); fs.mkdirSync(path.join(cwd, '.pi'), { recursive: true });
  const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = home;
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; fs.rmSync(root, {recursive:true,force:true}); });
  const tools = new Map(), events = new Map(), notices = [];
  extension({ on: (name, fn) => events.set(name, fn), registerTool: tool => tools.set(tool.name, tool), registerCommand(){}, registerShortcut(){}, registerMessageRenderer(){} });
  let trusted = false;
  const ctx = { cwd, isProjectTrusted: () => trusted, ui: {notify: (...args) => notices.push(args)}, sessionManager: {getSessionFile: () => undefined} };
  const write = (scope, data) => fs.writeFileSync(path.join(scope === 'user' ? home : path.join(cwd, '.pi'), 'cli-subagents.roles.json'), JSON.stringify(data));
  return { tools, events, ctx, write, notices, trust: value => trusted = value, description: () => tools.get('subagent').description };
}
const role = description => ({ description, instructions: 'PRIVATE_INSTRUCTIONS', model: 'PRIVATE_MODEL' });

test('dispatch exposes delegation guidance and effective roles without model settings or prompts', async t => {
  const h = harness(t);
  const guidance = 'Delegate outcomes, not implementation recipes.';
  assert.ok(h.description().includes(guidance), 'guidance is available without loading a skill');
  h.write('user', { analyst: role('Personal analysis'), worker: role('Personal worker') });
  h.write('project', { analyst: role('Project analysis'), projectonly: role('Project only') });
  await h.events.get('session_start')({}, h.ctx);
  assert.ok(h.description().includes(guidance), 'session-start catalog refresh retains guidance');
  assert.match(h.description(), /analyst.*Personal analysis/);
  assert.match(h.description(), /worker.*Personal worker/);
  assert.doesNotMatch(h.description(), /Project analysis|projectonly|PRIVATE_/);
  h.trust(true);
  await h.events.get('before_agent_start')({}, h.ctx);
  assert.ok(h.description().includes(guidance), 'turn-start catalog refresh retains guidance');
  assert.match(h.description(), /analyst.*Project analysis/);
  assert.match(h.description(), /projectonly.*Project only/);
  assert.doesNotMatch(h.description(), /Personal analysis|PRIVATE_/);
  assert.equal(h.tools.size, 4);
});

test('the parent sees the delegation guidance exactly once, whichever carrier holds it', async t => {
  const guidance = 'Delegate outcomes, not implementation recipes. Give the goal, essential context (relevant paths and confirmed facts), authorized scope, and acceptance or return needs. A new instance has not seen this conversation. Let the child investigate, choose an approach and verify its work; prescribe implementation details only when the user, compatibility or shared-work constraints require them.';
  const copies = h => [...h.tools.values()].reduce((total, tool) => {
    const texts = [tool.description ?? '', ...(tool.promptGuidelines ?? [])];
    return total + texts.reduce((sum, text) => sum + text.split(guidance).length - 1, 0);
  }, 0);
  const h = harness(t);
  // A second copy would spend context and imply the child owns less than it does.
  assert.equal(copies(h), 1, 'the guidance must reach the parent once after registration');
  await h.events.get('session_start')({}, h.ctx);
  assert.equal(copies(h), 1, 'catalog refresh must not add another copy');
  h.trust(true);
  await h.events.get('before_agent_start')({}, h.ctx);
  assert.equal(copies(h), 1, 'turn-start refresh must not add another copy');
});

test('catalog refresh removes stale roles and respects trust revocation and invalid configuration', async t => {
  const h = harness(t);
  h.trust(true); h.write('project', { temporary: role('Temporary description') });
  await h.events.get('session_start')({}, h.ctx);
  assert.match(h.description(), /temporary/);
  h.trust(false); await h.events.get('before_agent_start')({}, h.ctx);
  assert.doesNotMatch(h.description(), /temporary/);
  h.write('user', { custom: role('Old description') });
  await h.events.get('before_agent_start')({}, h.ctx);
  assert.match(h.description(), /Old description/);
  h.write('user', { replacement: role('New description') });
  await h.events.get('before_agent_start')({}, h.ctx);
  assert.match(h.description(), /New description/); assert.doesNotMatch(h.description(), /Old description/);
  h.write('user', { invalid: {} });
  await h.events.get('before_agent_start')({}, h.ctx);
  assert.doesNotMatch(h.description(), /New description/); assert.match(h.description(), /unavailable/i);
  assert.ok(h.notices.some(([text]) => /role/i.test(text)));
});

test('dispatch refuses inherited role properties but accepts an explicitly configured constructor role', async t => {
  const h = harness(t), calls = [];
  h.ctx.sessionManager.getSessionFile = () => path.join(h.ctx.cwd, 'parent.jsonl');
  t.mock.method(AgentManager.prototype, 'spawn', async (name, resolved) => {
    calls.push({ name, resolved });
    return { id: 'fixture', runId: 'fixture-run', role: name, phase: 'completed' };
  });
  const start = name => h.tools.get('subagent').execute('start', { action: 'start', role: name, task: 'fixture' }, undefined, undefined, h.ctx);
  for (const name of ['constructor', 'toString', '__proto__', 'missing-role']) {
    await assert.rejects(start(name), /Unknown role/);
  }
  assert.deepEqual(calls, [], 'invalid role names must fail before reaching the execution layer');
  const configured = role('A legitimate custom role');
  h.write('user', { constructor: configured });
  await start('constructor');
  assert.deepEqual(calls, [{ name: 'constructor', resolved: configured }], 'check ownership, not a name blacklist');
});

test('instance queries no longer load role configuration or return a redundant catalog', async t => {
  const h = harness(t); h.write('user', { invalid: {} });
  t.mock.method(AgentManager.prototype, 'list', () => []);
  t.mock.method(WorkspaceStore.prototype, 'list', async () => []);
  h.ctx.sessionManager.getSessionFile = () => '/fixture/parent.jsonl';
  const response = await h.tools.get('subagent_query').execute('query', { action: 'list' }, undefined, undefined, h.ctx);
  assert.deepEqual(JSON.parse(response.content[0].text), { agents: [], workspaces: [] });
});
