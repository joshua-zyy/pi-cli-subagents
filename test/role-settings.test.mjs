// Role document logic for `/cli-agents-setting`: scopes, CLI gating and file safety.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { addRole, deleteRole, fieldChoices, fieldIsChoice, readScope, roleRows, roleSummary, setField, visibleFields, writeScope } from '../dist/role-settings.js';
import { mergeRoles, validateRoleFile } from '../dist/roles.js';

const temp = () => fs.mkdtempSync(path.resolve('.test-output/role-settings-'));
const base = { description: 'worker role', instructions: 'Do the assigned work.' };

test('scope files: personal and project paths stay separate and validated', () => {
  const agent = temp(), cwd = temp();
  assert.equal(writeScope('user', agent, cwd, { worker: { ...base, cli: 'claude', model: 'opus', thinking: 'max' } }), path.join(agent, 'cli-subagents.roles.json'));
  assert.match(readScope('user', agent, cwd).worker.model, /opus/);
  assert.deepEqual(readScope('project', agent, cwd), {}, 'project scope stays empty until written');
  assert.deepEqual(readScope('user', temp(), cwd), {}, 'missing files read as empty');
});

test('an invalid document is rejected before it can overwrite the file', () => {
  const agent = temp(), cwd = temp();
  writeScope('user', agent, cwd, { worker: { ...base, cli: 'claude', model: 'opus', thinking: 'max' } });
  const file = path.join(agent, 'cli-subagents.roles.json'), before = fs.readFileSync(file, 'utf8');
  assert.throws(() => writeScope('user', agent, cwd, { worker: { ...base, cli: 'claude', thinking: 'minimal' } }), /Claude thinking/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'a rejected write leaves the previous document intact');
  fs.writeFileSync(file, '{"worker":');
  assert.throws(() => readScope('user', agent, cwd), /Unexpected|JSON/);
});

test('visible fields follow the chosen CLI instead of exposing every field at once', () => {
  assert.deepEqual(visibleFields(base), ['cli', 'description', 'instructions'], 'an empty role still chooses a CLI first');
  assert.deepEqual(visibleFields({ ...base, provider: 'opencode-go', model: 'deepseek' }), ['cli', 'provider', 'model', 'thinking', 'description', 'instructions'],
    'a role that already carries Pi fields is already a Pi role');
  assert.deepEqual(visibleFields({ ...base, cli: 'pi' }), ['cli', 'provider', 'model', 'thinking', 'description', 'instructions'], 'Pi has no permission mode to offer');
  assert.deepEqual(visibleFields({ ...base, cli: 'codex', model: 'gpt-6-luna' }), ['cli', 'model', 'effort', 'mode', 'description', 'instructions']);
  assert.deepEqual(visibleFields({ ...base, cli: 'claude' }), ['cli', 'model', 'thinking', 'mode', 'description', 'instructions']);
});

test('switching CLI drops fields the new CLI rejects and keeps compatible ones', () => {
  const pi = { ...base, cli: 'pi', provider: 'opencode-go', model: 'deepseek-v4.1-flash', thinking: 'max' };
  const claude = setField({}, 'worker', pi, 'cli', 'claude').worker;
  assert.equal(claude.cli, 'claude'); assert.equal(claude.model, 'deepseek-v4.1-flash'); assert.equal(claude.thinking, 'max');
  assert.equal(claude.provider, undefined, 'Claude has no Pi provider field');
  const dropped = setField({}, 'worker', { ...base, cli: 'pi', thinking: 'minimal' }, 'cli', 'claude').worker;
  assert.equal(dropped.thinking, undefined, 'off/minimal have no native --effort equivalent');
  const codex = setField({}, 'worker', claude, 'cli', 'codex').worker;
  assert.equal(codex.model, 'deepseek-v4.1-flash'); assert.equal(codex.thinking, undefined); assert.equal(codex.provider, undefined);
  const noModel = setField({}, 'worker', { ...base, cli: 'claude' }, 'cli', 'codex').worker;
  assert.equal(noModel.model, undefined);
  assert.throws(() => writeScope('user', temp(), temp(), { worker: noModel }), /Codex role requires model/, 'Codex cannot be saved without a model');
  const carried = setField({}, 'worker', { ...base, cli: 'claude', mode: 'plan' }, 'cli', 'claude').worker;
  assert.equal(carried.mode, 'plan', 're-selecting the same CLI keeps its mode');
  assert.equal(setField({}, 'worker', { ...base, cli: 'claude', mode: 'plan' }, 'cli', 'codex').worker.mode, undefined, 'the two CLIs name different postures');
});

test('mode is picked from the chosen CLI’s own list and can be cleared', () => {
  const claude = { ...base, cli: 'claude' };
  assert.deepEqual(fieldChoices(claude, 'mode'), ['acceptEdits', 'auto', 'manual', 'dontAsk', 'plan', 'bypassPermissions']);
  assert.deepEqual(fieldChoices({ ...base, cli: 'codex', model: 'm' }, 'mode'), ['read-only', 'workspace-write', 'full-access']);
  assert.deepEqual(fieldChoices({ ...base, cli: 'pi' }, 'mode'), [], 'a Pi role has no permission posture to pick');
  const set = setField({}, 'worker', claude, 'mode', 'plan').worker;
  assert.equal(set.mode, 'plan');
  assert.equal(setField({}, 'worker', set, 'mode', '').worker.mode, undefined, 'an empty choice clears the field');
  assert.throws(() => writeScope('user', temp(), temp(), { worker: setField({}, 'worker', claude, 'mode', 'full-access').worker }), /Claude mode/);
});

test('CLI choices expose only that CLI\u2019s levels', () => {
  assert.deepEqual(fieldChoices({ ...base, cli: 'claude' }, 'thinking'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(fieldChoices({ ...base, cli: 'pi' }, 'thinking'), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(fieldChoices({ ...base, cli: 'codex', model: 'm' }, 'effort'), ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(fieldChoices({ ...base, cli: 'claude' }, 'cli'), ['pi', 'codex', 'claude']);
});

test('a discovered catalog turns provider and model into pickers that keep an escape hatch', () => {
  const catalog = { pi: [{ provider: 'anthropic', model: 'claude-opus-5' }, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }],
    codex: [{ model: 'gpt-6-luna', efforts: ['low', 'high', 'max'] }] };
  const pi = { ...base, cli: 'pi' };
  assert.equal(fieldIsChoice(pi, 'model'), false, 'without a catalog the model stays free text');
  assert.equal(fieldIsChoice(pi, 'model', { catalog }), true);
  assert.equal(fieldIsChoice(pi, 'description', { catalog }), false, 'a text field never becomes a picker');
  assert.deepEqual(fieldChoices(pi, 'provider', { catalog }), ['anthropic', 'opencode-go']);
  assert.deepEqual(fieldChoices(pi, 'model', { catalog }), ['claude-opus-5', 'deepseek-v4.1-flash']);
  assert.deepEqual(fieldChoices({ ...pi, provider: 'opencode-go' }, 'model', { catalog }), ['deepseek-v4.1-flash'], 'the chosen provider narrows the model list');
  assert.deepEqual(fieldChoices(pi, 'model'), [], 'no catalog means no invented list');
  const codex = { ...base, cli: 'codex', model: 'gpt-6-luna' };
  assert.deepEqual(fieldChoices(codex, 'effort', { catalog }), ['low', 'high', 'max'], 'a model publishes its own levels');
  // The app-server defines effort as "a value advertised by the model", so a published level the
  // plugin never listed itself must still round-trip instead of being rejected on save.
  const agent = temp();
  writeScope('user', agent, agent, { worker: { ...codex, effort: 'ultra' } });
  assert.equal(readScope('user', agent, agent).worker.effort, 'ultra');
  assert.deepEqual(fieldChoices({ ...codex, model: 'unknown' }, 'effort', { catalog }), ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'an unknown model falls back to the generic list');
  assert.deepEqual(fieldChoices({ ...base, cli: 'claude' }, 'model', { catalog }), ['opus', 'sonnet', 'haiku', 'fable'], 'Claude publishes aliases rather than a catalog');
  assert.equal(fieldIsChoice({ ...base, cli: 'claude' }, 'model', { catalog }), true);
  assert.equal(fieldIsChoice({ ...base, cli: 'pi' }, 'model', { pending: true }), true, 'a pending probe keeps the picker open instead of asking for typing');
  assert.equal(fieldIsChoice({ ...base, cli: 'pi' }, 'provider', { pending: true }), true);
  assert.equal(fieldIsChoice({ ...base }, 'model', { pending: true }), false, 'a role without a CLI cannot pick a model yet');
  assert.equal(fieldIsChoice({ ...base, cli: 'claude' }, 'model'), true, 'Claude aliases are always offered');
  assert.equal(fieldIsChoice({ ...base, cli: 'codex', model: 'm' }, 'model'), false, 'a finished probe with nothing found leaves that field as text');
  assert.deepEqual(fieldChoices(pi, 'cli', { clis: ['pi'] }), ['pi'], 'the CLI picker offers only what this machine can launch');
});

test('rows report where the effective definition comes from', () => {
  const user = { worker: { ...base, cli: 'pi', model: 'user-model' } };
  const project = { worker: { ...base, cli: 'codex', model: 'project-model' }, tester: { ...base } };
  const effective = mergeRoles([user, project]);
  const rows = roleRows(effective, user, project, 'user');
  assert.equal(rows.find((row) => row.name === 'worker').origin, 'project');
  assert.equal(rows.find((row) => row.name === 'tester').origin, 'project');
  assert.equal(rows.find((row) => row.name === 'explore').origin, 'built-in');
  assert.equal(rows.find((row) => row.name === 'worker').effective.model, 'project-model', 'later scopes win');
  assert.equal(roleRows(effective, user, project, 'project').find((row) => row.name === 'worker').override.model, 'project-model');
});

test('add and remove only touch the edited scope', () => {
  const doc = addRole({}, 'tester');
  assert.equal(doc.tester.description, 'tester role');
  assert.ok(doc.tester.instructions.trim());
  assert.deepEqual(addRole(doc, 'tester'), doc, 'an existing entry is not replaced');
  assert.equal(deleteRole(doc, 'tester').tester, undefined);
  assert.deepEqual(deleteRole(doc, 'missing'), doc);
});

test('summaries describe the effective runtime without exposing the whole role', () => {
  assert.match(roleSummary({ ...base, cli: 'pi', provider: 'opencode-go', model: 'deepseek', thinking: 'max' }), /pi · opencode-go\/deepseek · thinking max/);
  assert.match(roleSummary({ ...base, cli: 'claude', model: 'opus', thinking: 'max' }), /claude · opus · effort max/);
  assert.match(roleSummary({ ...base, cli: 'claude', model: 'opus', mode: 'plan' }), /claude · opus · native effort · mode plan/);
  assert.match(roleSummary({ ...base, cli: 'claude' }), /native model · native effort/);
  assert.match(roleSummary({ ...base, cli: 'codex', model: 'gpt-6-luna', effort: 'max' }), /codex · gpt-6-luna · effort max/);
  assert.match(roleSummary({ ...base, cli: 'codex', model: 'gpt-6-luna', mode: 'full-access' }), /effort default · mode full-access/);
  assert.doesNotMatch(roleSummary({ ...base, cli: 'pi', provider: 'opencode-go' }), /· mode /, 'a Pi role never advertises a posture it cannot set');
});

test('validateRoleFile normalizes documents the same way the loader does', () => {
  const parsed = validateRoleFile({ worker: { ...base, cli: 'codex', model: 'gpt-6-luna', effort: 'max' } }, 'fixture');
  assert.deepEqual(parsed.worker, { ...base, cli: 'codex', model: 'gpt-6-luna', effort: 'max' });
  assert.throws(() => validateRoleFile({ worker: { ...base, extra: true } }, 'fixture'), /unknown fields/);
});
