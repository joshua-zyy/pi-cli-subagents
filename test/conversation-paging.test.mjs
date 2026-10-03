// Viewer paging: history is fetched only when the reader walks past an edge, and never in the background.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationViewer } from '../dist/ui/conversation.js';

const theme = { fg: (_color, text) => text, bold: text => text };
const agent = { id: 'agent-1', role: 'worker', phase: 'running', runId: 'run-1' };
const entry = (id, text) => ({ id, kind: 'assistant', title: 'Assistant', text });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await wait(5); }
  assert.fail('timed out waiting for the viewer');
}
const info = (atEnd, atStart = false, entries = 0) => ({ from: { source: 's', offset: 0 }, to: { source: 's', offset: 1 }, atStart, atEnd, entries });
function view(load, options = {}) {
  const frames = [], actions = [];
  const tui = { terminal: { rows: 14, columns: 90 }, requestRender() { frames.push(viewer.render(90).join('\n')); } };
  const viewer = new ConversationViewer(tui, theme, action => actions.push(action), load, { intervalMs: 20, ...options });
  return { viewer, frames, actions, text: () => viewer.render(90).join('\n') };
}

test('history is fetched only when the reader walks past a loaded edge, one request at a time', async t => {
  const entries = Array.from({ length: 60 }, (_, i) => entry(`E${i}`, `MESSAGE_${i}`));
  const calls = [];
  let current = { agent, entries, loading: false, revision: 1, window: info(true, false, 60), usageComplete: false };
  let resolveOlder;
  const h = view(async () => current,
    { paging: { older: () => { calls.push('older'); return new Promise(resolve => { resolveOlder = resolve; }); },
      newer: async () => { calls.push('newer'); assert.fail('nothing newer exists'); },
      latest: async () => { calls.push('latest'); assert.fail('already at the live end'); } } });
  t.after(() => h.viewer.dispose());
  await until(() => h.frames.length > 0);
  assert.deepEqual(calls, [], 'opening the viewer does not read history');
  const keys = { pageUp: '[5~', top: '[H', bottom: '[F' };
  h.viewer.handleInput(keys.pageUp); // PageUp away from the top: still browsing the loaded window.
  assert.deepEqual(calls, []);
  h.viewer.handleInput(keys.top); // Home reaches the loaded top.
  assert.deepEqual(calls, ['older']);
  h.viewer.handleInput(keys.top); h.viewer.handleInput(keys.pageUp); h.viewer.handleInput(keys.top);
  assert.deepEqual(calls, ['older'], 'a request in flight is never duplicated');
  const visible = h.text().match(/MESSAGE_\d+/g);
  const older = Array.from({ length: 25 }, (_, i) => entry(`H${i}`, `HISTORY_${i}`));
  current = { agent, entries: [...older, ...entries], loading: false, revision: 2, window: info(true, true, 85), usageComplete: false };
  resolveOlder(current);
  await until(() => !h.text().includes('Loading older history'));
  assert.deepEqual(h.text().match(/MESSAGE_\d+/g), visible, 'a prepended page does not move the paused viewport');
  assert.match(h.text(), /Paused/);
  h.viewer.handleInput(keys.top);
  assert.match(h.text(), /HISTORY_/, 'the older page is above the paused viewport');
  h.viewer.handleInput(keys.bottom);
  assert.match(h.text(), /MESSAGE_59/, 'End returns to the newest entry of the loaded window');
});

test('walking down past the loaded end restores evicted entries, and End returns to the live tail', async t => {
  const older = Array.from({ length: 50 }, (_, i) => entry(`O${i}`, `EVICTED_${i}`));
  const tail = [entry('LIVE', 'LIVE_TAIL')];
  const calls = [];
  let current = { agent, entries: older, loading: false, revision: 1, window: info(false, false, 50), usageComplete: false };
  const h = view(async () => current, { paging: {
    older: async () => { calls.push('older'); return current; },
    newer: async () => { calls.push('newer'); current = { agent, entries: [...older, ...tail], loading: false, revision: 2, window: info(true, true, 51), usageComplete: true, usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 } }; return current; },
    latest: async () => { calls.push('latest'); current = { agent, entries: tail, loading: false, revision: 3, window: info(true, false, 1), usageComplete: false }; return current; } } });
  t.after(() => h.viewer.dispose());
  await until(() => h.frames.length > 0);
  h.viewer.handleInput('\x1b[H');
  assert.deepEqual(calls, ['older'], 'the top edge is paged only when the window knows more exists');
  h.viewer.handleInput('\x1b[F'); // End: the loaded window is not at the live end, so it must fetch it.
  await until(() => calls.includes('latest'));
  await until(() => h.text().includes('LIVE_TAIL'));
  assert.match(h.text(), /Following/);
  assert.ok(!h.text().includes('EVICTED_0'), 'the re-anchored tail window is the live one');
});

test('incomplete totals are hidden behind an explicit label instead of a fabricated number', async t => {
  const entries = [entry('E1', 'READY')];
  const usage = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const h = view(async () => ({ agent, entries, loading: false, revision: 1, model: 'fixture-model', usage, usageComplete: false, window: info(true) }));
  t.after(() => h.viewer.dispose());
  await until(() => h.frames.length > 0);
  assert.match(h.text(), /Stats incomplete/);
  assert.doesNotMatch(h.text(), /1\.1k tokens/);
  const complete = view(async () => ({ agent, entries, loading: false, revision: 1, model: 'fixture-model', usage, usageComplete: true }));
  t.after(() => complete.viewer.dispose());
  await until(() => complete.frames.length > 0);
  assert.match(complete.text(), /1\.1k tokens · fixture-model/);
  const legacy = view(async () => ({ agent, entries, loading: false, revision: 1, model: 'fixture-model', usage }));
  t.after(() => legacy.viewer.dispose());
  await until(() => legacy.frames.length > 0);
  assert.match(legacy.text(), /1\.1k tokens · fixture-model/, 'snapshots without the flag keep their existing shape');
});

test('closing during an in-flight page stops rendering and further requests', async t => {
  const entries = Array.from({ length: 40 }, (_, i) => entry(`E${i}`, `MESSAGE_${i}`));
  const calls = [];
  let resolveOlder;
  const h = view(async () => ({ agent, entries, loading: false, revision: 1, window: info(true, false, 40) }),
    { paging: { older: () => { calls.push('older'); return new Promise(resolve => { resolveOlder = resolve; }); },
      newer: async () => ({ agent, entries, loading: false, revision: 1, window: info(true) }),
      latest: async () => ({ agent, entries, loading: false, revision: 1, window: info(true) }) } });
  await until(() => h.frames.length > 0);
  h.viewer.handleInput('\x1b[H');
  await until(() => calls.length === 1);
  h.viewer.dispose();
  const frames = h.frames.length;
  resolveOlder({ agent, entries: [...entries, entry('H', 'OLD_PAGE')], loading: false, revision: 2, window: info(true, true, 41) });
  await wait(60);
  assert.equal(h.frames.length, frames, 'a closed viewer never redraws a late page');
  assert.deepEqual(calls, ['older'], 'no further requests after close');
});

test('paging state keeps the existing keys working', async t => {
  const entries = [entry('T1', 'TOOL_OUTPUT'), { id: 't2', kind: 'tool', title: 'bash', input: '{"command":"npm test"}', text: 'TOOL_SECRET', status: 'done' }];
  const actions = [];
  const tui = { terminal: { rows: 24, columns: 100 }, requestRender() {} };
  const viewer = new ConversationViewer(tui, theme, action => actions.push(action), async () => ({ agent, entries, loading: false, revision: 1, window: info(true) }),
    { intervalMs: 20, onSend: async () => {} });
  t.after(() => viewer.dispose());
  await wait(40);
  assert.doesNotMatch(viewer.render(100).join('\n'), /TOOL_SECRET/);
  viewer.handleInput('\x0f'); // Ctrl+O
  assert.match(viewer.render(100).join('\n'), /TOOL_SECRET/);
  viewer.handleInput('\x0f');
  assert.doesNotMatch(viewer.render(100).join('\n'), /TOOL_SECRET/);
  viewer.handleInput('\r'); viewer.handleInput('hi'); viewer.handleInput('\r');
  await until(() => viewer.render(100).join('\n').includes('Message accepted'));
  viewer.handleInput('x');
  assert.deepEqual(actions, [{ kind: 'stop', id: agent.id }]);
});

test('a page move is not new output and does not clear a pending delivery notice', async t => {
  const entries = Array.from({ length: 30 }, (_, i) => entry(`E${i}`, `MESSAGE_${i}`));
  let revision = 1;
  const h = view(async () => ({ agent, entries, loading: false, revision, outputRevision: 1, window: info(true, false, 30) }),
    { onSend: async () => {}, paging: { older: async () => ({ agent, entries, loading: false, revision: ++revision, outputRevision: 1, window: info(true, false, 30) }),
      newer: async () => ({ agent, entries, loading: false, revision, outputRevision: 1, window: info(true) }),
      latest: async () => ({ agent, entries, loading: false, revision, outputRevision: 1, window: info(true) }) } });
  t.after(() => h.viewer.dispose());
  await until(() => h.frames.length > 0);
  h.viewer.handleInput('\r'); h.viewer.handleInput('hello'); h.viewer.handleInput('\r');
  await until(() => h.text().includes('Message accepted'));
  h.viewer.handleInput('\x1b[H');
  await until(() => h.text().includes('HISTORY') || h.frames.length > 3);
  assert.match(h.text(), /Message accepted/, 'an older page is not new child output');
});
