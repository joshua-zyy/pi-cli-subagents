import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ConversationViewer } from '../dist/ui/conversation.js';
import { TranscriptReader } from '../dist/ui/transcript.js';
import { tempDir } from './helpers/tmp.mjs';

const theme = { fg: (_color, text) => text, bold: text => text };
const agent = { id: 'agent-1', role: 'worker', phase: 'running', runId: 'run-2' };
const entry = text => ({ id: text, kind: 'assistant', title: 'Assistant', text });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await wait(5); }
  assert.fail('timed out waiting for the viewer');
}
function view(load, options = {}) {
  const frames = [], actions = [];
  const tui = { terminal: { rows: 14, columns: 90 }, requestRender() { frames.push(viewer.render(90).join('\n')); } };
  const viewer = new ConversationViewer(tui, theme, action => actions.push(action), load, { intervalMs: 20, ...options });
  return { viewer, frames, actions, text: () => viewer.render(90).join('\n') };
}

test('initial catch-up never publishes intermediate old messages as the visible conversation', async t => {
  let calls = 0, finish;
  const latest = new Promise(resolve => { finish = resolve; });
  const h = view(async () => ++calls === 1
    ? { agent, entries: [entry('OLD_INTERMEDIATE')], loading: true, revision: 1 }
    : latest);
  t.after(() => h.viewer.dispose());
  await until(() => calls === 2);
  assert.ok(h.frames.length > 0, 'loading remains visible while the next asynchronous read is pending');
  assert.ok(h.frames.every(frame => !frame.includes('OLD_INTERMEDIATE')), 'old replay batches must not appear on screen');
  assert.match(h.text(), /Loading/);
  h.viewer.handleInput('\x1b[H'); // Before content exists, Home must not change the initial landing position.
  finish({ agent, entries: [...Array.from({ length: 30 }, (_, i) => entry(`HISTORY_${i}`)), entry('LATEST_VISIBLE')], loading: false, revision: 2 });
  await until(() => h.frames.some(frame => frame.includes('LATEST_VISIBLE')));
  const firstContent = h.frames.find(frame => frame.includes('HISTORY_') || frame.includes('LATEST_VISIBLE'));
  assert.match(firstContent, /LATEST_VISIBLE/);
  assert.doesNotMatch(firstContent, /HISTORY_0\b/);
  h.viewer.handleInput('\x1b[H'); assert.match(h.text(), /HISTORY_0\b/);
  h.viewer.handleInput('\x1b[F'); assert.match(h.text(), /LATEST_VISIBLE/);
});

test('first visible content comes from the last chunk of the last run without losing history or lifetime usage', async t => {
  const dir = tempDir('viewer-loading');
  const oldFile = path.join(dir, 'old.jsonl'), activeFile = path.join(dir, 'active.jsonl');
  const record = (text, input) => ({ type: 'message_end', message: { role: 'assistant', content: text,
    usage: { input, output: 1, totalTokens: input + 1 } } });
  fs.writeFileSync(oldFile, JSON.stringify(record('OLD_RUN_MESSAGE', 10)) + '\n');
  // A record crossing the 512 KiB read boundary makes the active run itself load in multiple batches.
  fs.writeFileSync(activeFile, [record('ACTIVE_RUN_EARLY', 20), { type: 'ignored', padding: 'x'.repeat(600 * 1024) },
    record('LATEST_MESSAGE_END', 30)].map(JSON.stringify).join('\n') + '\n');
  const reader = new TranscriptReader(); let latest;
  const h = view(async () => { latest = await reader.read([oldFile, activeFile]); return { agent, ...latest }; });
  t.after(() => h.viewer.dispose());
  await until(() => h.frames.some(frame => frame.includes('LATEST_MESSAGE_END')));
  const contentFrames = h.frames.filter(frame => /OLD_RUN_MESSAGE|ACTIVE_RUN_EARLY|LATEST_MESSAGE_END/.test(frame));
  assert.ok(contentFrames.every(frame => frame.includes('LATEST_MESSAGE_END')), 'initial frames must not animate through old runs/chunks');
  assert.equal(latest.usage.input, 60);
  assert.equal(latest.usage.output, 3);
  assert.ok(latest.entries.some(e => e.text === 'OLD_RUN_MESSAGE'));
  h.viewer.handleInput('\x1b[H'); assert.match(h.text(), /OLD_RUN_MESSAGE/);
  fs.appendFileSync(activeFile, JSON.stringify(record('LIVE_AFTER_OPEN', 40)) + '\n');
  await until(() => latest.entries.some(e => e.text === 'LIVE_AFTER_OPEN'));
  assert.doesNotMatch(h.text(), /LIVE_AFTER_OPEN/, 'scrolling up still pauses follow');
  h.viewer.handleInput('\x1b[F'); assert.match(h.text(), /LIVE_AFTER_OPEN/);
  assert.equal(latest.usage.input, 100);
});

test('closing during initial catch-up prevents late content publication and further reads', async () => {
  let calls = 0, finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const h = view(async () => ++calls === 1
    ? { agent, entries: [entry('OLD')], loading: true, revision: 1 } : pending);
  await until(() => calls === 2);
  h.viewer.handleInput('\x1b');
  const count = h.frames.length;
  finish({ agent, entries: [entry('LATEST')], loading: false, revision: 2 });
  await wait(40);
  assert.equal(h.frames.length, count); assert.equal(calls, 2);
});

test('loading keeps agent status and actions available without advertising scrollable content', async t => {
  for (const [key, action] of [['x', { kind: 'stop', id: agent.id }], ['s', { kind: 'message', id: agent.id, resume: false }]]) {
    const h = view(async () => ({ agent, entries: [entry('OLD')], loading: true, revision: 1 }));
    t.after(() => h.viewer.dispose());
    await until(() => h.frames.length > 0);
    assert.match(h.text(), /worker.*Running/);
    assert.match(h.text(), /x stop/);
    assert.doesNotMatch(h.text(), /OLD|PgUp|Home\/End|↑↓ scroll/);
    h.viewer.handleInput(key);
    assert.deepEqual(h.actions, [action]);
  }
  const sent = [];
  const h = view(async () => ({ agent, entries: [], loading: true, revision: 1 }), { onSend: async text => { sent.push(text); } });
  t.after(() => h.viewer.dispose());
  await until(() => h.frames.length > 0);
  assert.match(h.text(), /Enter message/);
  h.viewer.handleInput('\r'); h.viewer.handleInput('hello'); h.viewer.handleInput('\r');
  await until(() => sent.length > 0);
  assert.deepEqual(sent, ['hello']);
  assert.deepEqual(h.actions, [], 'inline messages must not close the loading viewer');
});

test('a post-publication loading snapshot followed by an error waits before retrying', async t => {
  let calls = 0;
  const h = view(async () => {
    calls++;
    if (calls === 1) return { agent, entries: [entry('READY')], loading: false, revision: 1 };
    if (calls === 2) return { agent, entries: [entry('READY')], loading: true, revision: 2 };
    throw Error('later read failed');
  }, { intervalMs: 300 });
  t.after(() => h.viewer.dispose());
  await until(() => calls === 3);
  await wait(40);
  assert.equal(calls, 3);
  assert.match(h.text(), /later read failed/);
  assert.match(h.text(), /READY/);
});

test('a send notice created during loading survives the first content publication', async t => {
  for (const failure of [false, true]) {
    let calls = 0, finish;
    const gate = new Promise(resolve => { finish = resolve; });
    let current = { agent, entries: [entry('FIRST_CONTENT')], loading: false, revision: 2 };
    const h = view(async () => {
      if (++calls === 1) return { agent, entries: [], loading: true, revision: 1 };
      await gate; return current;
    }, { onSend: async () => { if (failure) throw Error('child gone'); } });
    t.after(() => h.viewer.dispose());
    await until(() => calls === 2);
    h.viewer.handleInput('\r'); h.viewer.handleInput('hello'); h.viewer.handleInput('\r');
    const notice = failure ? /Send failed: child gone/ : /Message accepted/;
    await until(() => notice.test(h.text()));
    finish();
    await until(() => h.text().includes('FIRST_CONTENT'));
    assert.match(h.text(), notice, 'publishing old history must not erase a fresh delivery result');
    current = { agent, entries: [entry('NEW_OUTPUT')], loading: false, revision: 3 };
    await until(() => h.text().includes('NEW_OUTPUT'));
    assert.doesNotMatch(h.text(), notice);
    h.viewer.dispose();
  }
});
