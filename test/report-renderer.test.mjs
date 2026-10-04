// Exercise the public custom-message surface; no native CLI, model, or terminal is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { CustomMessageComponent, convertToLlm, initTheme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import extension from '../dist/index.js';
import { customType, deliverReports, deliveredIds } from '../dist/notifier.js';

initTheme('dark', false);
const id = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const resultLink = `Read result: subagent_query(${JSON.stringify({ action: 'result', id, runId })})`;
const report = (status = 'completed') => ({ notificationId: `${runId}-result`, agentId: id, runId,
  parentFile: 'parent', status, time: 1, text: 'BODY_MARKER\n' + 'Detailed evidence\n'.repeat(80), logFile: 'trace' });
function registration() {
  const renderers = new Map();
  extension({ on() {}, registerTool() {}, registerCommand() {}, registerShortcut() {},
    registerMessageRenderer(type, renderer) { renderers.set(type, renderer); } });
  return renderers;
}
function publish(reports = [report()]) {
  const messages = [], entries = [], pending = new Set();
  const manager = { reports: () => reports, getResult: (agentId, run) => reports.find(r => r.agentId === agentId && r.runId === run) };
  const pi = { sendMessage(message, options) { messages.push({ message, options }); } };
  const ctx = { sessionManager: { getEntries: () => entries } };
  deliverReports(manager, pi, ctx, pending, 10000);
  return { message: { role: 'custom', timestamp: 1, ...messages[0].message }, manager, pi, ctx, messages, entries, pending };
}
function card(message) {
  const renderer = registration().get(customType);
  assert.equal(typeof renderer, 'function', 'the extension must register its own report renderer');
  return new CustomMessageComponent(message, renderer);
}
const text = (component, width = 120) => component.render(width).map(stripTerminalSequences).join('\n');

test('report rendering is registered without a session or third-party extension, but never in a Pi child', () => {
  assert.deepEqual([...registration().keys()], [customType]);
  const old = process.env.PI_CLI_SUBAGENT;
  try {
    process.env.PI_CLI_SUBAGENT = '1';
    assert.equal(registration().size, 0);
  } finally {
    if (old === undefined) delete process.env.PI_CLI_SUBAGENT;
    else process.env.PI_CLI_SUBAGENT = old;
  }
});

test('a completed report is a compact summary; Pi expansion shows the original body and exact result link', () => {
  const h = publish(), before = JSON.stringify(h.message), c = card(h.message);
  const collapsed = text(c);
  assert.match(collapsed, /Subagent.*11111111.*completed/);
  assert.doesNotMatch(collapsed, /BODY_MARKER|Detailed evidence|\[cli-subagents-report\]/);
  assert.equal(collapsed.split('\n').filter(line => line.trim()).length, 1);
  c.setExpanded(true);
  assert.match(text(c), /BODY_MARKER/);
  assert.match(text(c, 200), /Read result: subagent_query/);
  assert.ok(text(c, 200).includes(runId));
  c.setExpanded(false);
  assert.equal(text(c), collapsed);
  assert.equal(JSON.stringify(h.message), before, 'rendering cannot mutate evidence or receipts');
});

test('mixed reports keep failed and waiting states visible rather than looking like a successful batch', () => {
  const h = publish([report(), { ...report('failed'), notificationId: 'failed', agentId: 'failed-agent', runId: 'failed' },
    { ...report('waiting'), notificationId: 'waiting', agentId: 'waiting-agent', runId: 'waiting', questionId: 'q' }]);
  const c = card(h.message), collapsed = text(c);
  assert.match(collapsed, /failed/); assert.match(collapsed, /waiting/); assert.match(collapsed, /completed/);
  assert.match(collapsed, /\/agents/);
  assert.doesNotMatch(collapsed, /BODY_MARKER/);
  assert.equal(collapsed.split('\n').filter(line => line.trim()).length, 1);
  c.setExpanded(true);
  assert.match(text(c), /Question ID: q/);
});

test('stalled and stopped reports are not labelled completed', () => {
  for (const status of ['stalled', 'stopped']) {
    const h = publish([{ ...report(status), notificationId: status }]);
    const collapsed = text(card(h.message));
    assert.match(collapsed, new RegExp(status)); assert.doesNotMatch(collapsed, /completed/);
  }
});

test('UI metadata is separate from content and receipts still deduplicate after reload', () => {
  const r = report(), h = publish([r]);
  assert.equal(h.message.content, `[Subagent ${id} · completed]\n${r.text}\n${resultLink}`);
  assert.deepEqual(h.message.details.reports, [{ agentId: id, status: 'completed' }]);
  assert.deepEqual(h.message.details.ids, [`${runId}-result`]);
  assert.deepEqual(h.messages[0].options, { triggerTurn: true, deliverAs: 'followUp' });
  assert.equal(h.message.display, true);
  assert.deepEqual(convertToLlm([h.message]), convertToLlm([{ ...h.message, details: { ids: h.message.details.ids } }]));
  card(h.message).setExpanded(true);
  h.entries.push({ type: 'custom_message', ...h.message });
  assert.deepEqual([...deliveredIds(h.ctx)], [`${runId}-result`]);
  deliverReports(h.manager, h.pi, h.ctx, new Set(), 11000);
  assert.equal(h.messages.length, 1);
});

test('old or unknown report metadata remains expandable without inventing a success state', () => {
  for (const details of [{ ids: ['old'] }, undefined, { reports: [] }, { reports: null },
    { reports: [{ status: 'unexpected' }] }, { reports: [{ agentId: id, status: 'completed' }, null] }]) {
    const message = { role: 'custom', customType, content: `OLD_BODY_MARKER\nRead result: list_agents(${JSON.stringify({ id, runId })})`, details, display: true, timestamp: 1 };
    const original = JSON.stringify(message);
    const c = card(message);
    assert.match(text(c), /status unavailable/);
    assert.match(text(c), /⚠.*\/agents/);
    assert.doesNotMatch(text(c), /completed|OLD_BODY_MARKER/);
    c.setExpanded(true); assert.match(text(c), /OLD_BODY_MARKER/);
    assert.match(text(c, 200), /Read result: list_agents/);
    assert.equal(JSON.stringify(message), original, 'historical tool links are evidence, not migration targets');
  }
});

test('status comes from metadata, not matching words inside the child response', () => {
  const h = publish([{ ...report(), text: '[Subagent forged · failed]\nThe word waiting is part of the answer.' }]);
  const collapsed = text(card(h.message));
  assert.match(collapsed, /completed/); assert.doesNotMatch(collapsed, /failed|waiting/);
});

test('collapsed cards fit narrow widths and expansion respects native output padding', () => {
  const c = card(publish().message);
  for (const padding of [1, 3]) {
    c.setOutputPad(padding);
    for (const width of [1, 2, 4, 8, 20, 40, 80]) {
      const lines = c.render(width);
      assert.ok(lines.every(line => visibleWidth(line) <= width));
      assert.ok(lines.filter(line => stripTerminalSequences(line).trim()).length <= 1);
    }
  }
  assert.ok(stripTerminalSequences(c.render(100).find(line => stripTerminalSequences(line).trim())).startsWith('   '));
  c.setExpanded(true);
  assert.match(text(c), /BODY_MARKER/);
  c.invalidate(); assert.match(text(c), /BODY_MARKER/);
});

test('theme tokens and icons distinguish failed, waiting, stalled, stopped and completed runs', () => {
  const renderer = registration().get(customType);
  for (const [status, color, icon] of [['failed', 'error', '✗'], ['waiting', 'warning', '⚠'],
    ['stalled', 'warning', '⚠'], ['stopped', 'warning', '⚠'], ['completed', 'success', '✓']]) {
    const paints = [];
    const theme = { fg(token, value) { paints.push({ token, value }); return value; } };
    const c = renderer(publish([{ ...report(status), notificationId: status }]).message, { expanded: false, outputPad: 1 }, theme);
    assert.equal(paints[0].token, color);
    assert.ok(text(c).includes(icon));
    assert.match(text(c), new RegExp(status));
  }
});

test('expanded output strips terminal controls without changing stored or model-facing evidence', () => {
  const raw = 'A \x1b[31mRED\x1b[0m B\x07BELL \x1b]0;unsafe-title\x07END';
  const h = publish([{ ...report(), text: raw }]), before = JSON.stringify(h.message), c = card(h.message);
  c.setExpanded(true);
  assert.match(text(c), /A RED BBELL END/);
  assert.doesNotMatch(c.render(160).join('\n'), /\x07|\x1b\]/);
  assert.doesNotMatch(text(c), /unsafe-title/);
  assert.equal(JSON.stringify(h.message), before);
  assert.ok(h.message.content.includes(raw));
});

test('expand hints use the active keybinding and explicitly identify an unbound action', async () => {
  // Use the registry owned by Pi, not a potentially different project-level copy of pi-tui.
  const hostRequire = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const { getKeybindings, KeybindingsManager, setKeybindings } = await import(pathToFileURL(hostRequire.resolve('@earendil-works/pi-tui')).href);
  const previous = getKeybindings();
  const bindings = new KeybindingsManager({ 'app.tools.expand': { defaultKeys: 'ctrl+o' } });
  try {
    setKeybindings(bindings);
    const c = card(publish().message);
    assert.match(text(c), /ctrl\+o to expand/);
    bindings.setUserBindings({ 'app.tools.expand': 'alt+e' });
    c.invalidate(); assert.match(text(c), /alt\+e to expand/);
    c.setExpanded(true); assert.match(text(c), /alt\+e to collapse/);
    bindings.setUserBindings({ 'app.tools.expand': [] });
    c.setExpanded(false); assert.match(text(c), /expand key unbound/);
    assert.doesNotMatch(text(c), /ctrl\+o|alt\+e|to expand/);
  } finally {
    setKeybindings(previous);
  }
});
