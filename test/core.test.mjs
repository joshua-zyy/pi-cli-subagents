import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiProcess } from '../dist/pi-process.js';
import { loadRoles } from '../dist/roles.js';
import { writeJson, waitUntil } from '../dist/storage.js';

export const fixture = fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url));
const output = path.resolve('.test-output');
fs.mkdirSync(output, { recursive: true });
const temp = () => fs.mkdtempSync(path.join(output, 'unit-'));

test('RPC correlates requests, preserves Unicode separators, and surfaces rejection', async () => {
  const dir = temp(); const events = [];
  const rpc = new PiProcess({ command: process.execPath, args: [fixture] }, ['--session-dir', dir], dir, path.join(dir, 'events.jsonl'), (r) => events.push(r));
  try {
    const [state, history] = await Promise.all([rpc.request({ type: 'get_state' }), rpc.request({ type: 'get_messages' })]);
    assert.ok(state.sessionId); assert.deepEqual(history.messages, []);
    await assert.rejects(rpc.request({ type: 'prompt', message: 'REJECT' }), /rejected/);
    await rpc.request({ type: 'prompt', message: 'UNICODE' });
    await waitUntil('settled', () => events.find(e => e.type === 'agent_settled'));
    assert.equal(events.find(e => e.type === 'message_end').message.content[0].text, 'A\u2028B\u2029\u96ea');
  } finally { assert.equal((await rpc.end()).exit.code, 0); }
});

test('role settings inherit defaults; untrusted project files are not loaded', () => {
  const user = temp(), cwd = temp();
  // Built-in roles cover investigation, implementation and independent review.
  assert.deepEqual(Object.keys(loadRoles(user, cwd, true)), ['explore', 'worker', 'reviewer', 'oracle']);
  for (const role of Object.values(loadRoles(user, cwd, true))) {
    assert.ok(role.description.trim() && role.instructions.trim());
  }
  assert.match(loadRoles(user, cwd, true).explore.instructions, /not a read-only sandbox/, 'the explore role must not promise isolation it does not enforce');
  // Built-ins name Pi explicitly instead of leaving `cli` absent, so the editor shows their fields.
  for (const [name, role] of Object.entries(loadRoles(user, cwd, true))) assert.equal(role.cli, 'pi', `${name} must default to Pi`);
  writeJson(path.join(user, 'cli-subagents.roles.json'), { custom: { description: 'global', instructions: 'do work', model: 'chosen' } });
  writeJson(path.join(cwd, '.pi/cli-subagents.roles.json'), { custom: { description: 'project', instructions: 'project work', thinking: 'high' } });
  assert.equal(loadRoles(user, cwd, false).custom.model, 'chosen');
  assert.equal(loadRoles(user, cwd, true).custom.description, 'project');
  assert.equal(loadRoles(user, cwd, true).worker.model, undefined);
  writeJson(path.join(cwd, '.pi/cli-subagents.roles.json'), { custom: { description: 'bad', instructions: 'bad', models: 'typo' } });
  assert.throws(() => loadRoles(user, cwd, true), /unknown fields/);
  writeJson(path.join(cwd, '.pi/cli-subagents.roles.json'), { explore: { description: 'project explore', instructions: 'project instructions' } });
  assert.equal(loadRoles(user, cwd, true).explore.description, 'project explore', 'a configured role replaces the built-in one');
});

test('Codex role is explicit and rejects Pi-only provider/thinking fields', () => {
  const user = temp(), cwd = temp(), file = path.join(user, 'cli-subagents.roles.json');
  const role = { cli: 'codex', description: 'Codex review', instructions: 'Review the task', model: 'chosen-model', effort: 'medium' };
  writeJson(file, { 'codex-reviewer': role });
  assert.deepEqual(loadRoles(user, cwd, false)['codex-reviewer'], role);
  for (const invalid of [{ ...role, model: undefined }, { ...role, provider: 'openai' }, { ...role, thinking: 'max' }, { ...role, cli: 'other' }]) {
    writeJson(file, { 'codex-reviewer': invalid });
    assert.throws(() => loadRoles(user, cwd, false));
  }
  writeJson(file, { 'codex-reviewer': { ...role, effort: 'max' } });
  assert.equal(loadRoles(user, cwd, false)['codex-reviewer'].effort, 'max');
  writeJson(file, { worker: { description: 'Pi role', instructions: 'Test', effort: 'low' } });
  assert.throws(() => loadRoles(user, cwd, false), /effort requires/);
});

test('role mode is CLI-specific and never silently applied to an unsupported CLI', () => {
  const user = temp(), cwd = temp(), file = path.join(user, 'cli-subagents.roles.json');
  const base = { description: 'Role', instructions: 'Do the assigned work' };
  for (const mode of ['read-only', 'workspace-write', 'full-access']) {
    writeJson(file, { worker: { ...base, cli: 'codex', model: 'chosen-model', mode } });
    assert.equal(loadRoles(user, cwd, false).worker.mode, mode);
  }
  for (const mode of ['acceptEdits', 'auto', 'manual', 'dontAsk', 'plan', 'bypassPermissions']) {
    writeJson(file, { worker: { ...base, cli: 'claude', mode } });
    assert.equal(loadRoles(user, cwd, false).worker.mode, mode);
  }
  // The two CLIs name different postures, so a valid value for one is invalid for the other.
  for (const invalid of [{ cli: 'codex', model: 'm', mode: 'plan' }, { cli: 'claude', mode: 'read-only' }, { cli: 'claude', mode: '' }, { cli: 'claude', mode: 7 }]) {
    writeJson(file, { worker: { ...base, ...invalid } });
    assert.throws(() => loadRoles(user, cwd, false), /mode/);
  }
  // Pi's own `--mode` selects its output format, so a Pi role has no permission posture to set.
  for (const mode of ['full-access', 'plan']) {
    writeJson(file, { worker: { ...base, mode } });
    assert.throws(() => loadRoles(user, cwd, false), /mode requires cli: claude or codex/);
  }
});
