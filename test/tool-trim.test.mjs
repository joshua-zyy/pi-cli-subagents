import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AgentManager } from '../dist/manager.js';
import { defaultRoles, mcpError, skillsError, toolTrimError, validateRoleFile } from '../dist/roles.js';
import { trimArgs } from '../dist/pi-adapter.js';
import { subagentArgs as codexSubagentArgs } from '../dist/codex-adapter.js';
import { subagentArgs as claudeSubagentArgs } from '../dist/claude-adapter.js';
import { tempDir } from './helpers/tmp.mjs';

const launch = { command: process.execPath, args: [] };
// A child may not spawn grandchildren unless the role says so: every default argv carries this denial.
const noSubagent = ['--exclude-tools', 'subagent'];

test('trim flags follow the role and keep the no-respawn default', () => {
  assert.deepEqual(trimArgs({}), noSubagent, 'a role without tools still cannot spawn subagents');
  assert.deepEqual(trimArgs({ tools: { allow: ['read', 'bash'] } }), ['--tools', 'read,bash', ...noSubagent]);
  assert.deepEqual(trimArgs({ tools: { deny: ['mcp__*'] } }), ['--exclude-tools', 'mcp__*,subagent'],
    'the default joins the role deny list instead of adding a second flag');
  assert.deepEqual(trimArgs({ tools: { allow: ['read'], deny: ['write'] } }), ['--tools', 'read', '--exclude-tools', 'write,subagent']);
});

test('allowing subagents is explicit and can also come from the tool list', () => {
  assert.deepEqual(trimArgs({ allowSubagents: true }), [], 'the switch alone removes the denial');
  assert.deepEqual(trimArgs({ tools: { allow: ['read', 'subagent'] } }), ['--tools', 'read,subagent'],
    'an allowlist that names subagent is the other way to say yes');
  assert.deepEqual(trimArgs({ tools: { deny: ['subagent'] } }), ['--exclude-tools', 'subagent'],
    'an explicit denial is not duplicated');
  assert.deepEqual(trimArgs({ allowSubagents: false }), noSubagent, 'false means the same as omitted');
});

test('codex and claude deny their own spawn tool by default', () => {
  assert.deepEqual(codexSubagentArgs({}), ['-c', 'agents.enabled=false']);
  assert.deepEqual(codexSubagentArgs({ allowSubagents: true }), []);
  assert.deepEqual(claudeSubagentArgs({}), ['--disallowedTools', 'Agent']);
  assert.deepEqual(claudeSubagentArgs({ allowSubagents: true }), []);
});

test('tool trimming is Pi-only and its shape is checked', () => {
  assert.equal(toolTrimError(undefined, { allow: ['read'] }), undefined, 'an unset cli means Pi');
  assert.equal(toolTrimError('pi', { deny: ['write'] }), undefined);
  assert.match(toolTrimError('codex', { allow: ['read'] }), /Codex exposes no tool allow\/deny list/);
  assert.match(toolTrimError('claude', { allow: ['read'] }), /not wired for Claude yet/,
    'the message no longer claims Claude lacks a list');
  assert.match(toolTrimError('pi', []), /must be an object/);
  assert.match(toolTrimError('pi', {}), /needs allow and\/or deny/);
  assert.match(toolTrimError('pi', { allow: [] }), /non-empty array/);
  assert.match(toolTrimError('pi', { allow: [' read'] }), /without surrounding spaces/);
  assert.match(toolTrimError('pi', { allow: ['read'], extra: 1 }), /unknown fields: extra/);
});

test('the role file loader keeps tools and skills and mcp and the respawn switch', () => {
  const roles = validateRoleFile({ worker: { description: 'd', instructions: 'i', tools: { allow: ['read'] }, skills: ['/s'], mcp: false, allowSubagents: true } }, 'probe');
  assert.deepEqual(roles.worker.tools, { allow: ['read'] });
  assert.deepEqual(roles.worker.skills, ['/s']);
  assert.equal(roles.worker.mcp, false);
  assert.equal(roles.worker.allowSubagents, true);
  assert.throws(() => validateRoleFile({ worker: { description: 'd', instructions: 'i', tools: { allow: ['read'] }, cli: 'codex' } }, 'probe'), /Codex exposes no tool allow\/deny list/);
  assert.throws(() => validateRoleFile({ worker: { description: 'd', instructions: 'i', skills: [] } }, 'probe'), /non-empty array of skill paths/);
  assert.throws(() => validateRoleFile({ worker: { description: 'd', instructions: 'i', mcp: 'off' } }, 'probe'), /must be true or false/);
  assert.throws(() => validateRoleFile({ worker: { description: 'd', instructions: 'i', allowSubagents: 'yes' } }, 'probe'), /allowSubagents must be a boolean/);
  assert.equal(validateRoleFile({ worker: { description: 'd', instructions: 'i', allowSubagents: true, cli: 'codex' } }, 'probe').worker.allowSubagents, true,
    'every backend can enforce it now, so no backend is refused');
});

test('a false skills flag disables discovery and composes with the rest', () => {
  assert.deepEqual(trimArgs({ skills: false }), [...noSubagent, '--no-skills']);
  assert.deepEqual(trimArgs({ skills: true }), noSubagent);
  assert.deepEqual(trimArgs({ skills: false, tools: { allow: ['read'] } }), ['--tools', 'read', ...noSubagent, '--no-skills']);
});

test('the skills switch is Pi-only and boolean or a path list', () => {
  assert.equal(skillsError(undefined, false), undefined, 'an unset cli means Pi');
  assert.match(skillsError('codex', false), /skills requires a Pi role/);
  assert.match(skillsError('claude', false), /skills requires a Pi role/);
  assert.match(skillsError('pi', 'false'), /non-empty array of skill paths/);
  assert.match(skillsError('pi', {}), /non-empty array of skill paths/);
});

test('a skill path list means only those skills', () => {
  assert.deepEqual(trimArgs({ skills: ['/skills/a', 'b/SKILL.md'] }),
    [...noSubagent, '--no-skills', '--skill', '/skills/a', '--skill', 'b/SKILL.md'],
    'a list disables discovery and loads each path, which is what makes it a whitelist');
  assert.equal(skillsError('pi', ['/skills/a']), undefined);
  assert.match(skillsError('pi', []), /non-empty array of skill paths/);
  assert.match(skillsError('pi', [' spaced']), /without surrounding spaces/);
});

test('a false mcp flag disables MCP and composes with the other switches', () => {
  assert.deepEqual(trimArgs({ mcp: false }), [...noSubagent, '--no-mcp']);
  assert.deepEqual(trimArgs({ mcp: true }), noSubagent);
  assert.deepEqual(trimArgs({ tools: { allow: ['read'] }, skills: false, mcp: false }),
    ['--tools', 'read', ...noSubagent, '--no-skills', '--no-mcp'], 'all switches append independently');
  assert.equal(mcpError(undefined, false), undefined);
  assert.match(mcpError('codex', false), /mcp requires a Pi role/);
  assert.match(mcpError('pi', 'false'), /must be true or false/);
});

test('spawning a non-Pi role with a Pi-only field refuses before creating anything', async () => {
  const cwd = tempDir('trim');
  const parent = path.join(cwd, 'parent.jsonl');
  fs.writeFileSync(parent, '{}\n');
  const manager = new AgentManager(parent, launch);
  assert.equal(fs.existsSync(manager.root), false, 'nothing exists before the first instance');
  await assert.rejects(manager.spawn('worker', { ...defaultRoles.worker, cli: 'codex', tools: { allow: ['read'] } }, cwd, 'DO NOT START'),
    /Codex exposes no tool allow\/deny list/);
  await assert.rejects(manager.spawn('worker', { ...defaultRoles.worker, cli: 'claude', skills: false }, cwd, 'DO NOT START'),
    /skills requires a Pi role/);
  await assert.rejects(manager.spawn('worker', { ...defaultRoles.worker, cli: 'codex', mcp: false }, cwd, 'DO NOT START'),
    /mcp requires a Pi role/);
  await assert.rejects(manager.spawn('worker', { ...defaultRoles.worker, allowSubagents: 'yes' }, cwd, 'DO NOT START'),
    /allowSubagents must be a boolean/, 'spawn validates the shape too, not just the role loader');
  assert.equal(fs.existsSync(manager.root), false, 'a refused role must not create even the instance root');
});
