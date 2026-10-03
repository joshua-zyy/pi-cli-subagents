// `/cli-agents-setting` panel: list, CLI-first gating, choices, scope switch and save hints.
import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import { RoleSettingsPanel } from '../dist/ui/role-settings.js';

const theme = { fg: (_, text) => text, bold: text => text };
const keys = { up: '\u001b[A', down: '\u001b[B', enter: '\r', escape: '\u001b', tab: '\t', left: '\u001b[D' };
const role = (over = {}) => ({ description: 'd', instructions: 'i', ...over });
const row = (over = {}) => ({ name: 'worker', origin: 'built-in', effective: role({ cli: 'claude', model: 'opus', thinking: 'max' }), override: undefined, ...over });

function panel(rows, options = {}) {
  const actions = [];
  const instance = new RoleSettingsPanel(rows, options.scope ?? 'project', options.trusted ?? true, options.dirty ?? false, theme, (action) => actions.push(action), () => options.rows ?? 0,
    undefined, () => options.choices ?? {}, options.cursor);
  return { instance, actions, render: (width = 100) => instance.render(width).join('\n') };
}

test('list shows each role summary, origin and the key hints within the width', () => {
  const { render } = panel([
    row(),
    row({ name: 'explore', effective: role({ cli: 'pi', provider: 'opencode-go', model: 'deepseek-v4.1-flash', thinking: 'max' }), origin: 'user' }),
  ]);
  const text = render(100);
  assert.match(text, /Subagent roles — project/);
  assert.match(text, /› worker\s+claude · opus · effort max · built-in/);
  assert.match(text, /explore\s+pi · opencode-go\/deepseek-v4\.1-flash · thinking max · personal/);
  assert.match(text, /enter edit/); assert.match(text, /tab personal/); assert.match(text, /esc close/);
  for (const line of panel([row()]).instance.render(40)) assert.ok(visibleWidth(line) <= 40, line);
});

test('CLI-specific options appear only after a CLI is chosen', () => {
  const { instance, render } = panel([row({ effective: role() })]);
  instance.handleInput(keys.enter);
  const text = render(100);
  assert.match(text, /Choose a CLI first; its specific options appear after that\./);
  assert.match(text, /cli\s+\(empty\)/);
  assert.doesNotMatch(text, /thinking|provider|effort/);
});

test('after the CLI is set the panel shows that CLI\u2019s own fields', () => {
  const claude = panel([row()]);
  claude.instance.handleInput(keys.enter);
  const claudeText = claude.render(100);
  assert.match(claudeText, /cli\s+claude/); assert.match(claudeText, /model\s+opus/); assert.match(claudeText, /thinking\s+max/);
  assert.doesNotMatch(claudeText, /provider/);

  const codex = panel([row({ effective: role({ cli: 'codex', model: 'gpt-6-luna', effort: 'max' }) })]);
  codex.instance.handleInput(keys.enter);
  const codexText = codex.render(100);
  assert.match(codexText, /effort\s+max/); assert.doesNotMatch(codexText, /thinking/);

  const pi = panel([row({ effective: role({ cli: 'pi', provider: 'opencode-go', model: 'deepseek', thinking: 'max' }) })]);
  pi.instance.handleInput(keys.enter);
  const piText = pi.render(100);
  assert.match(piText, /provider\s+opencode-go/); assert.match(piText, /thinking\s+max/); assert.doesNotMatch(piText, /effort/);
  assert.doesNotMatch(piText, /^\s*(› )?mode\b/m, 'Pi has no native permission posture to offer');
});

test('mode is chosen from that CLI’s own postures and explains each one', () => {
  const claude = panel([row({ effective: role({ cli: 'claude', model: 'opus' }) })]);
  for (const key of [keys.enter, keys.down, keys.down, keys.down, keys.enter]) claude.instance.handleInput(key);
  const text = claude.render(120);
  assert.match(text, /worker · mode/);
  assert.match(text, /plan\s+reads auto-approved; writes always ask/);
  assert.match(text, /dontAsk\s+no prompts: anything unapproved is denied/);
  assert.doesNotMatch(text, /workspace-write/, 'Codex presets are never offered to a Claude role');
  claude.instance.handleInput(keys.enter);
  assert.deepEqual(claude.actions, [{ kind: 'set', role: 'worker', field: 'mode', value: 'acceptEdits' }]);
});

test('a mode that removes native approvals is called out before it is chosen', () => {
  const plain = panel([row({ effective: role({ cli: 'claude', model: 'opus' }) })]);
  plain.instance.handleInput(keys.enter);
  assert.doesNotMatch(plain.render(120), /stops asking for approval/);
  const bypass = panel([row({ effective: role({ cli: 'claude', model: 'opus', mode: 'bypassPermissions' }) })]);
  bypass.instance.handleInput(keys.enter);
  assert.match(bypass.render(160), /mode bypassPermissions: this role stops asking for approval/);
  const codex = panel([row({ effective: role({ cli: 'codex', model: 'gpt-6-luna', mode: 'full-access' }) })]);
  codex.instance.handleInput(keys.enter);
  assert.match(codex.render(160), /mode full-access: this role stops asking for approval/);
  codex.instance.handleInput(keys.down); codex.instance.handleInput(keys.down); codex.instance.handleInput(keys.down);
  codex.instance.handleInput(keys.enter);
  const presets = codex.render(120);
  assert.match(presets, /read-only\s+sandbox read-only; the model asks before escaping/);
  assert.match(presets, /full-access\s+current · no approvals and no sandbox/);
  assert.doesNotMatch(presets, /bypassPermissions/);
});

test('choosing a CLI returns the selected value and explains what each CLI configures', () => {
  const { instance, actions, render } = panel([row({ effective: role() })]);
  instance.handleInput(keys.enter);            // fields
  instance.handleInput(keys.enter);            // cli choices
  const text = render(100);
  assert.match(text, /worker · cli/);
  assert.match(text, /pi\s+provider · model · thinking/);
  assert.match(text, /codex\s+model \(required\) · effort \(reasoning\)/);
  instance.handleInput(keys.down);             // pi -> codex
  instance.handleInput(keys.enter);
  assert.deepEqual(actions, [{ kind: 'set', role: 'worker', field: 'cli', value: 'codex' }]);
});

test('level choices follow the CLI: Claude has no off/minimal, Pi does', () => {
  const claude = panel([row()]);
  claude.instance.handleInput(keys.enter);
  claude.instance.handleInput(keys.down);      // cli -> model
  claude.instance.handleInput(keys.down);      // model -> thinking
  claude.instance.handleInput(keys.enter);     // choices
  const claudeText = claude.render(100);
  assert.match(claudeText, /low/); assert.match(claudeText, /max/); assert.doesNotMatch(claudeText, /minimal/);

  const pi = panel([row({ effective: role({ cli: 'pi', thinking: 'max' }) })]);
  pi.instance.handleInput(keys.enter);
  pi.instance.handleInput(keys.down);          // cli -> provider
  pi.instance.handleInput(keys.down);          // provider -> model
  pi.instance.handleInput(keys.down);          // model -> thinking
  pi.instance.handleInput(keys.enter);
  assert.match(pi.render(100), /minimal/);
});

test('scope switching is offered only for a trusted project', () => {
  const trusted = panel([row()]);
  trusted.instance.handleInput(keys.tab);
  assert.deepEqual(trusted.actions, [{ kind: 'scope', scope: 'user' }]);
  const untrusted = panel([row()], { trusted: false });
  untrusted.instance.handleInput(keys.tab);
  assert.deepEqual(untrusted.actions, [], 'an untrusted project file is never edited');
  assert.match(untrusted.render(100), /project \(untrusted, not loaded\)/);
});

test('dirty drafts advertise save without making Esc an immediate discard action', () => {
  const clean = panel([row()]);
  clean.instance.handleInput('s');
  assert.deepEqual(clean.actions, [], 'save is unavailable without changes');
  const dirty = panel([row()], { dirty: true });
  assert.match(dirty.render(100), /• unsaved/);
  dirty.instance.handleInput('s');
  assert.deepEqual(dirty.actions, [{ kind: 'save' }]);
});

test('enter edits the highlighted role, and the list keeps its own cursor', () => {
  const { instance, render } = panel([
    row({ name: 'explore', effective: role({ cli: 'pi', model: 'deepseek' }) }),
    row({ name: 'worker', effective: role({ cli: 'claude', model: 'opus' }) }),
    row({ name: 'reviewer', effective: role({ cli: 'codex', model: 'gpt-6-luna' }) }),
  ]);
  instance.handleInput(keys.down);            // explore -> worker
  instance.handleInput(keys.enter);
  assert.match(render(100), /worker — project/);
  assert.doesNotMatch(render(100), /explore — project/, 'the first row must not open instead');
  instance.handleInput(keys.down);            // the field cursor is independent of the row cursor
  assert.match(render(100), /› model\s+opus/);
  instance.handleInput(keys.escape);
  assert.equal(instance.selection, 1, 'returning to the list keeps the edited role selected');
  instance.handleInput(keys.enter);
  assert.match(render(100), /worker — project/);
});

test('the panel is drawn as a border that fills the width it is given', () => {
  const { instance } = panel([row()]);
  for (const width of [60, 40]) {
    const lines = instance.render(width);
    assert.match(lines[0], /^╭─+╮$/); assert.equal(visibleWidth(lines[0]), width);
    assert.match(lines.at(-1), /^╰─+╯$/); assert.equal(visibleWidth(lines.at(-1)), width);
    for (const line of lines.slice(1, -1)) { assert.match(line, /^│ .* │$/); assert.equal(visibleWidth(line), width, line); }
  }
  // Too narrow to frame: the content is still bounded rather than overflowing.
  for (const line of instance.render(8)) assert.ok(visibleWidth(line) <= 8, line);
});

test('escape closes from the list and steps back from a field view', () => {
  const { instance, actions } = panel([row()]);
  instance.handleInput(keys.enter);
  instance.handleInput(keys.escape);
  assert.equal(instance.mode, 'list');
  assert.deepEqual(actions, [], 'leaving the field view is not an action');
  instance.handleInput(keys.escape);
  assert.deepEqual(actions, [{ kind: 'close' }]);
});

test('text fields are handed to the command layer instead of being edited inline', () => {
  const { instance, actions } = panel([row()]);
  instance.handleInput(keys.enter);   // fields
  for (const _ of [1, 2, 3, 4]) instance.handleInput(keys.down);   // cli -> model -> thinking -> mode -> description
  instance.handleInput(keys.enter);
  assert.deepEqual(actions, [{ kind: 'edit', role: 'worker', field: 'description' }]);
});

test('a pending probe keeps the picker open with a way out instead of a dead list', () => {
  const pending = panel([row({ effective: role({ cli: 'pi' }) })], { choices: { pending: true } });
  pending.instance.handleInput(keys.enter);   // fields
  pending.instance.handleInput(keys.down);    // cli -> provider
  pending.instance.handleInput(keys.enter);
  const text = pending.render(100);
  assert.match(text, /worker · provider/);
  assert.match(text, /Reading this CLI's own model list…/);
  assert.match(text, /✎ type a value…/, 'the picker is never dead while discovery runs');
  pending.instance.handleInput(keys.escape);
  assert.equal(pending.instance.mode, 'fields', 'escape still steps back');
  pending.instance.handleInput(keys.enter);   // reopen the picker (the field cursor never left provider)
  pending.instance.handleInput(keys.enter);   // the escape hatch is the only entry while pending
  assert.deepEqual(pending.actions, [{ kind: 'edit', role: 'worker', field: 'provider' }], 'enter still types a value on request');
});

test('a Claude model is picked from its documented aliases', () => {
  const { instance, actions, render } = panel([row()]);
  instance.handleInput(keys.enter);
  instance.handleInput(keys.down);            // cli -> model
  instance.handleInput(keys.enter);
  const text = render(100);
  assert.match(text, /worker · model/);
  assert.match(text, /opus\s+current/); assert.match(text, /sonnet/);
  assert.match(text, /✎ type a value…/, 'a full model name is still reachable');
  instance.handleInput(keys.down);
  instance.handleInput(keys.enter);
  assert.deepEqual(actions, [{ kind: 'set', role: 'worker', field: 'model', value: 'sonnet' }]);
});

test('a discovered catalog becomes a picker whose last entry types a value of your own', () => {
  const catalog = { pi: [{ provider: 'anthropic', model: 'claude-opus-5' }], codex: [{ model: 'gpt-6-luna', efforts: ['low', 'max'] }] };
  const cli = panel([row({ effective: role({ cli: 'pi' }) })], { choices: { clis: ['pi'] } });
  for (const key of [keys.enter, keys.enter, keys.enter]) cli.instance.handleInput(key);
  const clis = cli.render(100);
  assert.match(clis, /pi\s+(current · )?provider · model · thinking/);
  assert.doesNotMatch(clis, /codex|claude/, 'an uninstalled CLI is never offered');
  cli.instance.handleInput(keys.enter);
  assert.deepEqual(cli.actions, [{ kind: 'set', role: 'worker', field: 'cli', value: 'pi' }]);

  const model = panel([row({ effective: role({ cli: 'pi' }) })], { choices: { catalog } });
  for (const key of [keys.enter, keys.down, keys.down, keys.enter]) model.instance.handleInput(key);
  assert.match(model.render(100), /worker · model/);
  assert.match(model.render(100), /claude-opus-5/);
  assert.match(model.render(100), /✎ type a value…/);
  model.instance.handleInput(keys.down);      // the escape hatch is the last entry
  model.instance.handleInput(keys.enter);
  assert.deepEqual(model.actions, [{ kind: 'edit', role: 'worker', field: 'model' }], 'a value the CLI did not publish is typed, not invented');
});

test('without a catalog the model stays a plain text field', () => {
  const { instance, actions } = panel([row({ effective: role({ cli: 'pi' }) })]);
  instance.handleInput(keys.enter);
  instance.handleInput(keys.down); instance.handleInput(keys.down);
  instance.handleInput(keys.enter);
  assert.deepEqual(actions, [{ kind: 'edit', role: 'worker', field: 'model' }]);
});

test('a role that already carries Pi fields edits them without demanding a CLI', () => {
  const pi = panel([row({ effective: role({ provider: 'opencode-go', model: 'deepseek-v4.1-flash', thinking: 'max' }) })]);
  pi.instance.handleInput(keys.enter);
  const text = pi.render(100);
  assert.match(text, /› cli\s+\(empty\)/);
  assert.match(text, /provider\s+opencode-go/); assert.match(text, /model\s+deepseek-v4\.1-flash/);
  assert.doesNotMatch(text, /Choose a CLI first/, 'the Pi fields are already on screen');
});

test('the panel reopens where the user left off instead of at the top of the list', () => {
  const rows = [row({ name: 'explore', effective: role({ cli: 'pi' }) }), row({ name: 'oracle', effective: role({ cli: 'pi', model: 'deepseek' }) })];
  const resumed = panel(rows, { cursor: { role: 'oracle', field: 'model' } });
  assert.equal(resumed.instance.mode, 'fields', 'the role stays open after a change');
  assert.equal(resumed.instance.selection, 1, 'the role cursor is restored by name');
  assert.match(resumed.render(100), /oracle — project/);
  assert.match(resumed.render(100), /› model\s+deepseek/, 'the field cursor returns to the edited field');

  const elsewhere = panel(rows, { cursor: { role: 'explore' } });
  assert.match(elsewhere.render(100), /explore — project/);
  assert.match(elsewhere.render(100), /› cli/, 'a role cursor without a field starts at the top of that role');

  assert.equal(panel(rows, { cursor: { role: 'deleted' } }).instance.mode, 'list', 'a role that no longer exists falls back to the list');
  // Switching to Codex drops `thinking`, so the cursor falls back instead of pointing at nothing.
  const dropped = panel([row({ name: 'oracle', effective: role({ cli: 'codex', model: 'gpt-6-luna' }) })], { cursor: { role: 'oracle', field: 'thinking' } });
  assert.equal(dropped.instance.mode, 'fields');
  assert.match(dropped.render(100), /› cli/);
});

test('small row budgets keep every selected role visible without exceeding the frame', () => {
  for (const budget of [1, 2, 4, 6, 8, 14]) {
    const p = panel(Array.from({ length: 12 }, (_, i) => row({ name: `role-${i}` })), { rows: budget });
    for (let i = 0; i < 12; i++) {
      for (const width of [40, 100]) {
        const lines = p.instance.render(width);
        assert.ok(lines.length <= budget, `height ${lines.length} exceeds ${budget}`);
        assert.ok(lines.every(line => visibleWidth(line) <= width));
        assert.match(lines.join('\n'), new RegExp(`› role-${i}\\b`), `role ${i} hidden at budget ${budget}`);
      }
      p.instance.handleInput(keys.down);
    }
  }
});

test('field selection survives notes and approval warnings in a short terminal', () => {
  for (const effective of [role({ cli: 'pi' }), role({ cli: 'codex', model: 'gpt-6-luna', mode: 'full-access' }),
    role({ cli: 'claude', model: 'opus', mode: 'bypassPermissions' })]) {
    const fields = effective.cli === 'pi' ? ['cli', 'provider', 'model', 'thinking', 'description', 'instructions']
      : ['cli', 'model', effective.cli === 'codex' ? 'effort' : 'thinking', 'mode', 'description', 'instructions'];
    for (const budget of [4, 6, 8, 14]) {
      const p = panel([row({ effective })], { rows: budget, choices: { pending: true } });
      p.instance.handleInput(keys.enter);
      for (const field of fields) {
        const lines = p.instance.render(100);
        assert.ok(lines.length <= budget);
        assert.match(lines.join('\n'), new RegExp(`› ${field}\\b`), `${field} hidden at ${budget} rows`);
        if (effective.mode && budget >= 6) assert.match(lines.join('\n'), /stops asking for approval/);
        p.instance.handleInput(keys.down);
      }
    }
  }
});

test('short model pickers keep every choice visible even with a current-value footer', () => {
  const models = Array.from({ length: 30 }, (_, i) => ({ provider: 'p', model: `model-${i}` }));
  const p = panel([row({ effective: role({ cli: 'pi', provider: 'p', model: 'custom-model' }) })],
    { rows: 8, choices: { catalog: { pi: models, codex: [] } }, cursor: { role: 'worker', field: 'model' } });
  p.instance.handleInput(keys.enter);
  for (let i = 0; i <= 30; i++) {
    const lines = p.instance.render(100);
    assert.ok(lines.length <= 8);
    assert.match(lines.join('\n'), i < 30 ? new RegExp(`› model-${i}\\b`) : /› ✎ type a value/);
    assert.match(lines.join('\n'), /Current value: custom-model/);
    p.instance.handleInput(keys.down);
  }
});

test('dirty Esc hints match back and close behavior without discarding the draft', () => {
  const p = panel([row()], { dirty: true });
  assert.match(p.render(), /esc close/); assert.doesNotMatch(p.render(), /esc discard/);
  p.instance.handleInput(keys.enter);
  assert.match(p.render(), /esc back/); assert.doesNotMatch(p.render(), /esc discard/);
  p.instance.handleInput(keys.escape);
  assert.deepEqual(p.actions, []); assert.match(p.render(), /unsaved/);
  p.instance.handleInput(keys.escape); assert.deepEqual(p.actions, [{ kind: 'close' }]);
});
