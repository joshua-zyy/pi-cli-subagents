import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AgentManager } from '../dist/manager.js';
import { readJson, writeJson, waitUntil } from '../dist/storage.js';
import { deliverReports } from '../dist/notifier.js';
const launch = { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url))] };
fs.mkdirSync('.test-output', { recursive: true });
const released = (m, id) => waitUntil('terminal owner release', () => {
  const s = m.get(id);
  return ['completed', 'failed', 'stopped'].includes(s.phase) && !fs.existsSync(path.join(m.root, id, 'owner.lock')) ? s : undefined;
}, 10000);
function setup(t) {
  const cwd = fs.mkdtempSync(path.resolve('.test-output/manager-recovery-'));
  const m = new AgentManager(path.join(cwd, 'parent.jsonl'), launch);
  t.after(async () => {
    for (const s of m.list()) if (s.runId && fs.existsSync(path.join(m.root, s.id, 'owner.lock'))) await m.close(s.id);
  });
  return { cwd, m };
}

test('incomplete or unreadable registrations stay visible without blocking healthy notifications', { timeout: 15000 }, async t => {
  const { cwd, m } = setup(t);
  const good = await m.spawn('worker', { description: 'test', instructions: 'test' }, cwd, 'HEALTHY');
  await released(m, good.id);
  const spec = readJson(path.join(m.root, good.id, 'spec.json'));
  const bad = [];
  for (const kind of ['missing-state', 'malformed-state', 'empty-state', 'foreign-state', 'foreign-spec']) {
    const id = randomUUID(), dir = path.join(m.root, id); bad.push(id);
    writeJson(path.join(dir, 'spec.json'), { ...spec, id, ...(kind === 'foreign-spec' ? { parentFile: 'foreign' } : {}) });
    if (kind === 'malformed-state') fs.writeFileSync(path.join(dir, 'state.json'), '{');
    if (kind === 'empty-state') writeJson(path.join(dir, 'state.json'), {});
    if (kind === 'foreign-state') writeJson(path.join(dir, 'state.json'), readJson(path.join(m.root, good.id, 'state.json')));
  }
  const states = m.list(); assert.equal(states.length, 6);
  for (const id of bad) {
    const diagnostic = states.find(s => s.id === id);
    assert.equal(diagnostic.phase, 'unreachable'); assert.match(diagnostic.error, /record|inspect|unavailable/i);
    assert.equal(diagnostic.runId, '', 'no invented execution identity');
    assert.equal(diagnostic.session, undefined); assert.equal(diagnostic.history, undefined); assert.equal(diagnostic.runCount, undefined);
    assert.throws(() => m.get(id)); await assert.rejects(m.send(id, 'DO NOT RESTART')); await assert.rejects(m.close(id));
    assert(!fs.existsSync(path.join(m.root, id, 'runs')), 'diagnosis must not dispatch, recover or delete records');
  }
  const reports = m.reports(); assert.equal(reports.length, 1); assert.equal(reports[0].agentId, good.id);
  const messages = [];
  deliverReports(m, { sendMessage: message => messages.push(message) }, { sessionManager: { getEntries: () => [] } }, new Set(), Date.now() + 3000, states);
  assert.equal(messages.length, 1); assert.match(messages[0].content, /HEALTHY/);
  assert(!messages[0].content.includes('-unreachable'), 'no fabricated failed run for an incomplete registration');
});

test('terminal worker PID reuse does not block close or original-session continuation', { timeout: 40000 }, async t => {
  const { cwd, m } = setup(t);
  const first = await m.spawn('worker', { description: 'test', instructions: 'test' }, cwd, 'REMEMBER original');
  const end = await released(m, first.id), stateFile = path.join(m.root, first.id, 'state.json');
  const original = readJson(stateFile); writeJson(stateFile, { ...original, workerPid: process.pid });
  try {
    const start = Date.now();
    const closed = await m.close(first.id);
    assert.equal(closed.sessionId, end.sessionId); assert(Date.now() - start < 1000);
    await m.send(first.id, 'RECALL'); const next = await released(m, first.id);
    assert.equal(next.text, 'original'); assert.equal(next.sessionId, end.sessionId);
    assert.equal(next.sessionFile, end.sessionFile); assert.equal(next.runCount, 2);
  } finally {
    if (readJson(stateFile).runId === original.runId) writeJson(stateFile, original);
  }
});

test('terminal records with a stale ownership lock are not reclaimed or resumed', { timeout: 15000 }, async t => {
  const { cwd, m } = setup(t);
  const first = await m.spawn('worker', { description: 'test', instructions: 'test' }, cwd, 'DONE'); await released(m, first.id);
  const lock = path.join(m.root, first.id, 'owner.lock');
  try {
    for (const owner of [{ pid: 2147483647, runId: first.runId }, null, {}, { pid: process.pid, runId: randomUUID() }]) {
      writeJson(lock, owner);
      await assert.rejects(m.send(first.id, 'DO NOT RESTART'), /lock|owner/i);
      await assert.rejects(m.close(first.id), /lock|owner/i);
      assert(fs.existsSync(lock)); assert.equal(m.get(first.id).runCount, 1);
    }
  } finally { fs.unlinkSync(lock); }
});
