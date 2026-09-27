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
  assert.match(h.sent[0].message.content, /\[Subagent agent · completed\]\nDONE/);
  assert.doesNotMatch(h.sent[0].message.content, /Full event log:|Result file:|trace|run first/);
  assert.deepEqual(h.sent[0].options, { triggerTurn: true, deliverAs: 'steer' });
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

test('error and waiting messages keep actionable details without embedding file paths', () => {
  const h=harness([{...report('failed'),status:'failed',error:'Permission denied',text:'',logFile:'C:\\long\\secret\\events.jsonl',resultFile:'C:\\long\\secret\\result.json'},
    {...report('waiting'),status:'waiting',text:'Approve one operation?',questionId:'q',logFile:'C:\\long\\secret\\events.jsonl'}]);
  deliverReports(h.manager,h.pi,h.ctx,new Set());
  const content=h.sent[0].message.content;
  assert.match(content,/Permission denied/);assert.match(content,/Approve one operation\?/);
  assert.match(content, /Question ID: q.*list_pending_permissions/s);
  assert.doesNotMatch(content,/C:\\long|Full event log|Result file/);
  assert.deepEqual(h.sent[0].message.details.ids,['failed','waiting']);
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

test('nearby successes share a two-second window; later successes start a new batch', () => {
  const reports = [report('first')]; reports[0].time = 1000;
  const h = harness(reports), pending = new Set();
  deliverReports(h.manager, h.pi, h.ctx, pending, 1000);
  assert.equal(h.sent.length, 0);
  reports.push({ ...report('second'), time: 2500 });
  deliverReports(h.manager, h.pi, h.ctx, pending, 2999);
  assert.equal(h.sent.length, 0);
  deliverReports(h.manager, h.pi, h.ctx, pending, 3000);
  assert.deepEqual(h.sent[0].message.details.ids, ['first', 'second']);
  reports.push({ ...report('third'), time: 3200 });
  deliverReports(h.manager, h.pi, h.ctx, pending, 4000);
  assert.equal(h.sent.length, 1);
  deliverReports(h.manager, h.pi, h.ctx, pending, 5200);
  assert.deepEqual(h.sent[1].message.details.ids, ['third']);
});

test('failure, waiting and inactivity alerts flush held successes without waiting', () => {
  for (const status of ['failed', 'waiting', 'stalled']) {
    const reports = [{ ...report('success'), time: 1000 }];
    const h = harness(reports), pending = new Set();
    deliverReports(h.manager, h.pi, h.ctx, pending, 1200);
    assert.equal(h.sent.length, 0);
    reports.push({ ...report(status), time: 1300, status, text: status === 'waiting' ? 'Approve one operation?' : 'Needs attention' });
    deliverReports(h.manager, h.pi, h.ctx, pending, 1300);
    assert.deepEqual(h.sent[0].message.details.ids, ['success', status]);
    assert.equal(h.sent.length, 1);
  }
});

test('long output is explicitly clipped with a way to inspect the full result', () => {
  const h = harness([{ ...report('long'), text: 'A'.repeat(10000) }]);
  deliverReports(h.manager, h.pi, h.ctx, new Set());
  assert.ok(h.sent[0].message.content.length < 4000);
  assert.match(h.sent[0].message.content, /truncated.*list_agents.*agent/is);
});

test('no-session parent must fail closed rather than create unowned agents', async () => {
  const { parentManager } = await import('../dist/index.js');
  assert.throws(() => parentManager({ sessionManager: { getSessionFile: () => undefined } }, { command: 'pi', args: [] }), /persistent parent session/);
});
