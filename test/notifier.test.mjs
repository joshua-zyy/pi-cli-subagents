import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverReports, deliveredIds } from '../dist/notifier.js';

function harness(reports) {
  const sent = [], entries = [];
  const pi = { sendMessage(message, options) { sent.push({ message, options }); } };
  const ctx = { sessionManager: { getEntries: () => entries } };
  const manager = { reports: () => reports };
  return { sent, entries, pi, ctx, manager };
}
const report = (id) => ({ notificationId: id, agentId: 'agent', runId: id, status: 'completed', time: 1, text: 'DONE', logFile: 'trace' });

test('multiple reports are batched, queued once while pending, and deduplicated from persisted custom messages', () => {
  const h = harness([report('first'), report('second')]);
  const pending = new Set();
  deliverReports(h.manager, h.pi, h.ctx, pending);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].message.details.ids, ['first', 'second']);
  assert.deepEqual(h.sent[0].options, { triggerTurn: true, deliverAs: 'followUp' });
  deliverReports(h.manager, h.pi, h.ctx, pending);
  assert.equal(h.sent.length, 1, 'polling cannot queue a duplicate before message is persisted');
  // Pi persists ExtensionAPI.sendMessage as a SessionManager custom_message entry,
  // not as a model-facing { type: 'message', message: { role: 'custom' } } entry.
  h.entries.push({ type: 'custom_message', customType: 'cli-subagents-report', details: { ids: ['first', 'second'] } });
  const restarted = new Set();
  deliverReports(h.manager, h.pi, h.ctx, restarted);
  assert.equal(h.sent.length, 1, 'restart must not replay a report already in the parent session');
  assert.deepEqual([...deliveredIds(h.ctx)], ['first', 'second']);
});

test('a crashed delivery before append retries; after append does not', () => {
  const h = harness([report('missing')]); const pending = new Set();
  h.pi.sendMessage = () => { throw Error('not appended'); };
  assert.throws(() => deliverReports(h.manager, h.pi, h.ctx, pending), /not appended/);
  assert.equal(pending.size, 0);
  h.pi.sendMessage = (m, o) => h.sent.push({ message: m, options: o });
  deliverReports(h.manager, h.pi, h.ctx, pending);
  assert.equal(h.sent.length, 1);
});

test('no-session parent must fail closed rather than create unowned agents', async () => {
  const { parentManager } = await import('../dist/index.js');
  assert.throws(() => parentManager({ sessionManager: { getSessionFile: () => undefined } }, { command: 'pi', args: [] }), /persistent parent session/);
});
