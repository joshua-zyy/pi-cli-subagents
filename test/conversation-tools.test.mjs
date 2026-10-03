import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { getKeybindings, setKeybindings, KeybindingsManager } from '@earendil-works/pi-tui';
import { ConversationViewer } from '../dist/ui/conversation.js';

const theme = { fg: (_, text) => text, bold: text => text };
const agent = { id: 'agent', role: 'worker', phase: 'running', runId: 'run' };
const tool = (id, status = 'done', text = `OUTPUT_${id}`) => ({ id, kind: 'tool', title: `tool_${id}`, input: '{"path":"file.ts"}', status, text });
const message = id => ({ id, kind: 'assistant', title: 'Assistant', text: `MESSAGE_${id}` });
const wait = () => new Promise(resolve => setTimeout(resolve, 25));
async function setup(t, entries, options = {}, rows = 50, viewerTheme = theme) {
  let snapshot = { agent, entries, loading: false, revision: 1 };
  const tui = { terminal: { rows, columns: 100 }, requestRender() {} };
  const viewer = new ConversationViewer(tui, viewerTheme, () => {}, async () => snapshot, { intervalMs: 5, ...options });
  t.after(() => viewer.dispose());
  await wait();
  return { viewer, tui, text: () => viewer.render(tui.terminal.columns).join('\n'), update(next) { snapshot = { ...snapshot, ...next, revision: snapshot.revision + 1 }; } };
}

test('all tool states default to one compact row and Ctrl+O toggles all details without mutating evidence', async t => {
  const entries = [tool('done'), tool('error', 'error'), tool('running', 'running'), message('last')];
  const original = JSON.stringify(entries);
  const h = await setup(t, entries);
  const compact = h.text();
  assert.doesNotMatch(compact, /OUTPUT_/);
  assert.match(compact, /✗.*tool_error/);
  const rows = compact.split('\n');
  assert.equal(rows.findIndex(r => r.includes('tool_error')), rows.findIndex(r => r.includes('tool_done')) + 1);
  assert.equal(rows.findIndex(r => r.includes('tool_running')), rows.findIndex(r => r.includes('tool_error')) + 1);
  assert.match(compact, /ctrl\+o tools/);
  h.viewer.handleInput('\x0f');
  for (const id of ['done', 'error', 'running']) assert.match(h.text(), new RegExp(`OUTPUT_${id}`));
  h.viewer.handleInput('\x0f');
  assert.doesNotMatch(h.text(), /OUTPUT_/);
  assert.match(h.text(), /MESSAGE_last/);
  assert.equal(JSON.stringify(entries), original);
});

test('collapsed tools do not read or lay out their output', async t => {
  const entry = tool('lazy', 'error');
  Object.defineProperty(entry, 'text', { get() { throw Error('Output read while collapsed'); } });
  const h = await setup(t, [entry]);
  assert.match(h.text(), /tool_lazy/);
});

test('expanded tools show loaded input and early output beyond the old twelve-line preview', async t => {
  const entry = tool('full', 'done', Array.from({ length: 20 }, (_, i) => `LINE_${i}`).join('\n'));
  entry.input = JSON.stringify({ path: 'file.ts', content: 'ARG_BEGIN' + 'x'.repeat(180) + 'ARG_END' });
  const h = await setup(t, [entry]);
  h.viewer.handleInput('\x0f');
  assert.match(h.text(), /LINE_0\b/);
  assert.match(h.text(), /LINE_19\b/);
  assert.match(h.text(), /ARG_END/);
  assert.doesNotMatch(h.text(), /earlier lines/);
});

test('completed empty output is not reported as still running', async t => {
  const h = await setup(t, [tool('empty', 'done', '')]);
  h.viewer.handleInput('\x0f');
  assert.doesNotMatch(h.text(), /running/);
});

test('injected host bindings drive both hint and action; remapping and unbinding do not fall back to Ctrl+O', async t => {
  for (const keys of [['alt+o'], []]) {
    const calls = [];
    const keybindings = { getKeys(action) { calls.push(action); return keys; }, matches() { return false; } };
    const h = await setup(t, [tool('keys')], { keybindings });
    assert.doesNotMatch(h.text(), /ctrl\+o/);
    h.viewer.handleInput('\x0f');
    assert.doesNotMatch(h.text(), /OUTPUT_keys/);
    h.viewer.handleInput('\x1bo');
    if (keys.length) { assert.match(h.text(), /OUTPUT_keys/); assert.match(h.text(), /alt\+o tools/); }
    else assert.doesNotMatch(h.text(), /OUTPUT_keys/);
    assert.ok(calls.includes('app.tools.expand'));
  }
});

test('toggle anchors a paused entry rather than its obsolete line index', async t => {
  const entries = Array.from({ length: 25 }, (_, i) => tool(String(i), 'done', `OUTPUT_${i}\nsecond\nthird`));
  const h = await setup(t, entries, {}, 14);
  h.text(); h.viewer.handleInput('\x1b[H');
  for (let i = 0; i < 12; i++) h.viewer.handleInput('\x1b[B');
  assert.match(h.text(), /tool_12/);
  h.viewer.handleInput('\x0f');
  const expanded = h.text();
  assert.match(expanded, /tool_12/);
  assert.match(expanded, /Paused/);
  h.viewer.handleInput('\x0f');
  assert.match(h.text(), /tool_12/);
  h.viewer.handleInput('\x1b[F');
  h.viewer.handleInput('\x0f');
  assert.match(h.text(), /OUTPUT_24/);
  assert.match(h.text(), /Following/);
});

test('expansion survives updates and historical handoff, but is local to each viewer', async t => {
  const h = await setup(t, [tool('first')]);
  h.viewer.handleInput('\x0f');
  h.update({ historyLoading: true, entries: [tool('first'), tool('new', 'running')] });
  await wait(); assert.match(h.text(), /OUTPUT_new/);
  h.update({ historyLoading: false, entries: [tool('old'), tool('first'), tool('new', 'done')] });
  await wait(); assert.match(h.text(), /OUTPUT_old/);
  const other = await setup(t, [tool('first')]);
  assert.doesNotMatch(other.text(), /OUTPUT_first/);
});

test('inline composer keeps ownership of keys and Enter still sends', async t => {
  const sent = [];
  const h = await setup(t, [tool('composer')], { onSend: text => { sent.push(text); } });
  h.viewer.handleInput('\r');
  h.viewer.handleInput('\x0f');
  h.viewer.handleInput('hello');
  h.viewer.handleInput('\r');
  await wait();
  assert.deepEqual(sent, ['hello']);
  assert.doesNotMatch(h.text(), /OUTPUT_composer/);
});

test('live revisions reuse unchanged blocks but invalidate on width, theme, mode and eviction', async t => {
  const counts = new Map();
  const capture = { ...theme, fg(color, text) {
    if (color === 'toolOutput') counts.set(text, (counts.get(text) ?? 0) + 1);
    return text;
  } };
  const h = await setup(t, [tool('stable'), tool('changing')], {}, 50, capture);
  h.viewer.handleInput('\x0f'); h.text();
  assert.equal(counts.get('OUTPUT_stable'), 1);
  h.update({ entries: [tool('stable'), tool('changing', 'done', 'NEW_OUTPUT')] });
  await wait(); h.text();
  assert.equal(counts.get('OUTPUT_stable'), 1, 'unchanged output must not be laid out again');
  assert.equal(counts.get('NEW_OUTPUT'), 1);
  h.viewer.invalidate(); h.text();
  assert.equal(counts.get('OUTPUT_stable'), 2, 'host theme invalidation refreshes blocks');
  h.tui.terminal.columns = 80; h.text();
  assert.equal(counts.get('OUTPUT_stable'), 3, 'resize rebuilds blocks');
  h.viewer.handleInput('\x0f'); h.text();
  h.viewer.handleInput('\x0f'); h.text();
  assert.equal(counts.get('OUTPUT_stable'), 4, 'expansion mode invalidates blocks');
  h.update({ entries: [tool('changing')] }); await wait(); h.text();
  h.update({ entries: [tool('stable'), tool('changing')] }); await wait(); h.text();
  assert.equal(counts.get('OUTPUT_stable'), 5, 'removed entries do not linger in the block cache');
});

test('coalesced append and historical handoff apply their pending offset exactly once before toggling', async t => {
  const entries = Array.from({ length: 25 }, (_, i) => tool(String(i)));
  const h = await setup(t, entries, {}, 14);
  h.update({ historyLoading: true }); await wait(); h.text();
  h.viewer.handleInput('\x1b[H');
  for (let i = 0; i < 12; i++) h.viewer.handleInput('\x1b[B');
  assert.match(h.text(), /tool_12/);
  const appended = [...entries, tool('25')];
  h.update({ entries: appended }); await wait(); // Publish, but deliberately do not render.
  h.update({ historyLoading: false, entries: [tool('olderA'), tool('olderB'), ...appended] });
  await wait();
  h.viewer.handleInput('\x0f');
  assert.equal(h.text().match(/tool_\d+/)?.[0], 'tool_12');
  assert.equal(h.text().match(/tool_\d+/)?.[0], 'tool_12');
  h.viewer.handleInput('\x1b[B'); h.viewer.handleInput('\x1b[B'); // Inside the expanded entry.
  h.viewer.handleInput('\x0f');
  assert.equal(h.text().match(/tool_\d+/)?.[0], 'tool_12');
});

test('the host package manager is injected without reading or changing the project registry', async t => {
  const hostRequire = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const host = await import(pathToFileURL(hostRequire.resolve('@earendil-works/pi-tui')).href);
  const bindings = new host.KeybindingsManager({ 'app.tools.expand': { defaultKeys: 'ctrl+o' } });
  const previous = getKeybindings();
  const unrelated = new KeybindingsManager({ 'app.tools.expand': { defaultKeys: 'alt+x' } });
  try {
    setKeybindings(unrelated);
    const h = await setup(t, [tool('host')], { keybindings: bindings });
    assert.match(h.text(), /ctrl\+o tools/);
    h.viewer.handleInput('\x0f'); assert.match(h.text(), /OUTPUT_host/);
    bindings.setUserBindings({ 'app.tools.expand': 'alt+o' });
    h.viewer.handleInput('\x0f'); assert.match(h.text(), /OUTPUT_host/);
    h.viewer.handleInput('\x1bo'); assert.doesNotMatch(h.text(), /OUTPUT_host/);
    assert.match(h.text(), /alt\+o tools/);
    bindings.setUserBindings({ 'app.tools.expand': [] });
    h.viewer.handleInput('\x0f'); h.viewer.handleInput('\x1bo');
    assert.doesNotMatch(h.text(), /OUTPUT_host|ctrl\+o tools|alt\+o tools/);
    assert.equal(getKeybindings(), unrelated, 'viewer must not mutate the global registry');
  } finally { setKeybindings(previous); }
});
