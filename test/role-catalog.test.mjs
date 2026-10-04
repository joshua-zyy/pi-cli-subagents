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

test('dispatch description exposes effective names and descriptions, not model settings or prompts', async t => {
  const h = harness(t);
  h.write('user', { analyst: role('Personal analysis'), worker: role('Personal worker') });
  h.write('project', { analyst: role('Project analysis'), projectonly: role('Project only') });
  await h.events.get('session_start')({}, h.ctx);
  assert.match(h.description(), /analyst.*Personal analysis/);
  assert.match(h.description(), /worker.*Personal worker/);
  assert.doesNotMatch(h.description(), /Project analysis|projectonly|PRIVATE_/);
  h.trust(true);
  await h.events.get('before_agent_start')({}, h.ctx);
  assert.match(h.description(), /analyst.*Project analysis/);
  assert.match(h.description(), /projectonly.*Project only/);
  assert.doesNotMatch(h.description(), /Personal analysis|PRIVATE_/);
  assert.equal(h.tools.size, 4);
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

test('instance queries no longer load role configuration or return a redundant catalog', async t => {
  const h = harness(t); h.write('user', { invalid: {} });
  t.mock.method(AgentManager.prototype, 'list', () => []);
  t.mock.method(WorkspaceStore.prototype, 'list', async () => []);
  h.ctx.sessionManager.getSessionFile = () => '/fixture/parent.jsonl';
  const response = await h.tools.get('subagent_query').execute('query', { action: 'list' }, undefined, undefined, h.ctx);
  assert.deepEqual(JSON.parse(response.content[0].text), { agents: [], workspaces: [] });
});
