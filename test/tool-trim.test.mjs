import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AgentManager } from '../dist/manager.js';
import { defaultRoles, mcpError, skillsError, toolTrimError, validateRoleFile } from '../dist/roles.js';
import { trimArgs } from '../dist/pi-adapter.js';
import { tempDir } from './helpers/tmp.mjs';

const launch = { command: process.execPath, args: [] };

test('trim flags follow the role and stay empty without the field', () => {
  assert.deepEqual(trimArgs({}), [], 'a role without tools adds no flags, so existing argv is unchanged');
  assert.deepEqual(trimArgs({ tools: { allow: ['read', 'bash'] } }), ['--tools', 'read,bash']);
  assert.deepEqual(trimArgs({ tools: { deny: ['mcp__*'] } }), ['--exclude-tools', 'mcp__*']);
  assert.deepEqual(trimArgs({ tools: { allow: ['read'], deny: ['write'] } }), ['--tools', 'read', '--exclude-tools', 'write']);
});

test('tool trimming is Pi-only and its shape is checked', () => {
  assert.equal(toolTrimError(undefined, { allow: ['read'] }), undefined, 'an unset cli means Pi');
  assert.equal(toolTrimError('pi', { deny: ['write'] }), undefined);
  assert.match(toolTrimError('codex', { allow: ['read'] }), /Pi role: Codex and Claude expose no tool allow\/deny list/);
  assert.match(toolTrimError('claude', { allow: ['read'] }), /Pi role/);
  assert.match(toolTrimError('pi', []), /must be an object/);
  assert.match(toolTrimError('pi', {}), /needs allow and\/or deny/);
  assert.match(toolTrimError('pi', { allow: [] }), /non-empty array/);
  assert.match(toolTrimError('pi', { allow: [' read'] }), /without surrounding spaces/);
  assert.match(toolTrimError('pi', { allow: ['read'], extra: 1 }), /unknown fields: extra/);
});

test('the role file loader keeps tools instead of dropping it', () => {
  const roles = validateRoleFile({ worker: { description: 'd', instructions: 'i', tools: { allow: ['read'] } } }, 'probe');
  assert.deepEqual(roles.worker.tools, { allow: ['read'] }, 'a known field must survive loading');
  assert.throws(() => validateRoleFile({ worker: { description: 'd', instructions: 'i', tools: { allow: ['read'] }, cli: 'codex' } }, 'probe'),
    /tools requires a Pi role/);
  assert.throws(() => validateRoleFile({ worker: { description: 'd', instructions: 'i', tools: [] } }, 'probe'), /must be an object/);
});

test('spawning a non-Pi role with tools refuses before creating anything', async t => {
  const cwd = tempDir('trim');
  const parent = path.join(cwd, 'parent.jsonl');
  fs.writeFileSync(parent, '{}\n');
  const manager = new AgentManager(parent, launch);
  assert.equal(fs.existsSync(manager.root), false, 'nothing exists before the first instance');
  await assert.rejects(manager.spawn('worker', { ...defaultRoles.worker, cli: 'codex', tools: { allow: ['read'] } }, cwd, 'DO NOT START'),
    /Pi role: Codex and Claude expose no tool allow\/deny list/);
  assert.equal(fs.existsSync(manager.root), false, 'a refused role must not create even the instance root');
});

test('a false skills flag disables discovery and leaves other roles untouched', () => {
  assert.deepEqual(trimArgs({ skills: false }), ['--no-skills']);
  assert.deepEqual(trimArgs({ skills: true }), [], 'true means inherit, so no flag is passed');
  assert.deepEqual(trimArgs({ skills: false, tools: { allow: ['read'] } }), ['--tools', 'read', '--no-skills'],
    'both switches compose');
});

test('the skills switch is Pi-only and boolean', () => {
  assert.equal(skillsError(undefined, false), undefined, 'an unset cli means Pi');
  assert.equal(skillsError('pi', true), undefined);
  assert.match(skillsError('codex', false), /skills requires a Pi role/);
  assert.match(skillsError('claude', false), /skills requires a Pi role/);
  assert.match(skillsError('pi', 'false'), /must be true or false/);
  assert.match(skillsError('pi', 0), /must be true or false/);
  assert.match(skillsError('pi', {}), /must be true or false/);
});

test('the role file loader keeps skills and refuses it for other backends', () => {
  const roles = validateRoleFile({ worker: { description: 'd', instructions: 'i', skills: false } }, 'probe');
  assert.equal(roles.worker.skills, false, 'a known field must survive loading');
  assert.throws(() => validateRoleFile({ worker: { description: 'd', instructions: 'i', skills: false, cli: 'codex' } }, 'probe'),
    /skills requires a Pi role/);
  assert.throws(() => validateRoleFile({ worker: { description: 'd', instructions: 'i', skills: 'no' } }, 'probe'),
    /must be true or false/);
});

test('spawning a non-Pi role with skills refuses before creating anything', async () => {
  const cwd = tempDir('skills');
  const parent = path.join(cwd, 'parent.jsonl');
  fs.writeFileSync(parent, '{}\n');
  const manager = new AgentManager(parent, launch);
  await assert.rejects(manager.spawn('worker', { ...defaultRoles.worker, cli: 'claude', skills: false }, cwd, 'DO NOT START'),
    /skills requires a Pi role/);
  assert.equal(fs.existsSync(manager.root), false, 'a refused role must not create even the instance root');
});

test('a false mcp flag disables MCP and composes with the other switches', () => {
  assert.deepEqual(trimArgs({ mcp: false }), ['--no-mcp']);
  assert.deepEqual(trimArgs({ mcp: true }), [], 'true means inherit, so no flag is passed');
  assert.deepEqual(trimArgs({ tools: { allow: ['read'] }, skills: false, mcp: false }),
    ['--tools', 'read', '--no-skills', '--no-mcp'], 'all three switches append independently');
});

test('the mcp switch is Pi-only and boolean', () => {
  assert.equal(mcpError(undefined, false), undefined);
  assert.match(mcpError('codex', false), /mcp requires a Pi role/);
  assert.match(mcpError('claude', false), /mcp requires a Pi role/);
  assert.match(mcpError('pi', 'false'), /must be true or false/);
  assert.match(mcpError('pi', 0), /must be true or false/);
});

test('the role file loader keeps mcp and refuses it for other backends', () => {
  const roles = validateRoleFile({ worker: { description: 'd', instructions: 'i', mcp: false } }, 'probe');
  assert.equal(roles.worker.mcp, false);
  assert.throws(() => validateRoleFile({ worker: { description: 'd', instructions: 'i', mcp: false, cli: 'codex' } }, 'probe'),
    /mcp requires a Pi role/);
  assert.throws(() => validateRoleFile({ worker: { description: 'd', instructions: 'i', mcp: 'off' } }, 'probe'),
    /must be true or false/);
});

test('spawning a non-Pi role with mcp refuses before creating anything', async () => {
  const cwd = tempDir('mcp');
  const parent = path.join(cwd, 'parent.jsonl');
  fs.writeFileSync(parent, '{}\n');
  const manager = new AgentManager(parent, launch);
  await assert.rejects(manager.spawn('worker', { ...defaultRoles.worker, cli: 'codex', mcp: false }, cwd, 'DO NOT START'),
    /mcp requires a Pi role/);
  assert.equal(fs.existsSync(manager.root), false, 'a refused role must not create even the instance root');
});
