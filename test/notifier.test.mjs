import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverReports, deliveredIds } from '../dist/notifier.js';
import { AgentSession } from '@earendil-works/pi-coding-agent';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Exercise the same agent loop the installed host uses, without a model or a new dependency.
const hostRequire = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
const corePackage = pathToFileURL(hostRequire.resolve('@earendil-works/pi-agent-core/package.json'));
const { Agent } = await import(new URL('./dist/index.js', corePackage).href);

function harness(reports) {
  const sent = [], entries = [], notifications = [], statuses = [];
  const pi = { sendMessage(message, options) { sent.push({ message, options }); } };
  const ui = { notify: (message, type) => notifications.push([message, type]), setStatus: (key, text) => statuses.push([key, text]) };
  const ctx = { sessionManager: { getEntries: () => entries }, ui };
  const manager = { reports: () => reports, getResult: (id, runId) => reports.find(r => r.agentId === id && r.runId === runId) };
  return { sent, entries, notifications, statuses, ui, pi, ctx, manager };
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

test('error and waiting messages keep actionable details without embedding file paths', () => {
  const h=harness([{...report('failed'),status:'failed',error:'Permission denied',text:'',logFile:'C:\\long\\secret\\events.jsonl',resultFile:'C:\\long\\secret\\result.json'},
    {...report('waiting'),status:'waiting',text:'Approve one operation?',questionId:'q',logFile:'C:\\long\\secret\\events.jsonl'}]);
  deliverReports(h.manager,h.pi,h.ctx,new Set());
  const content=h.sent[0].message.content;
  assert.match(content,/Permission denied/);assert.match(content,/Approve one operation\?/);
  assert.match(content, /Question ID: q.*subagent_reply/s);
  assert.doesNotMatch(content,/C:\\long|Full event log|Result file/);
  assert.deepEqual(h.sent[0].message.details.ids,['failed','waiting']);
});

test('a waiting notification states the request type, its offered values and exactly what the parent may submit', () => {
  const audited = { method: 'select', options: ['Block', 'Allow once', 'Allow for this session', 'Always allow in this cwd'], parentPolicy: { values: ['Block', 'Allow once'] } };
  const h = harness([
    { ...report('guard'), status: 'waiting', text: 'Dangerous bash command', questionId: 'q1', request: audited },
    { ...report('plain'), status: 'waiting', text: 'Allow fixture operation?', questionId: 'q2', request: { method: 'confirm' } },
    { ...report('huge'), status: 'waiting', text: 'Y'.repeat(9000), questionId: 'q3', request: audited },
  ]);
  deliverReports(h.manager, h.pi, h.ctx, new Set());
  const content = h.sent[0].message.content;
  assert.match(content, /Question ID: q1 \(select; offered: "Block", "Allow once", "Allow for this session", "Always allow in this cwd"\)\. You may submit "Block", "Allow once", or cancelled\./);
  assert.match(content, /Handle this request now with subagent_reply within the user's task authorization; do not wait for routine human approval\./);
  assert.match(content, /The other options \("Allow for this session", "Always allow in this cwd"\) require a wider grant; involve the human only if that grant is needed: \/agent-reply agent q1\./);
  assert.match(content, /Question ID: q2 \(confirm\)\. You may only refuse it \(confirmed: false or cancelled\); the human answers it with \/agent-reply agent q2\./);
  // A clipped request body must not hide what the parent needs in order to answer at all.
  assert.match(content, /characters omitted/);
  assert.match(content, /Question ID: q3 \(select; offered: "Block"/);
});

test('routine approvals stay with the parent without asking the human to take over', () => {
  const request = { method: 'select', options: ['Block', 'Allow once'], parentPolicy: { values: ['Block', 'Allow once'] } };
  const h = harness([{ ...report('guard'), status: 'waiting', text: 'Dangerous bash command', questionId: 'q1', request }]);
  const states = [{ id: 'agent', runId: 'guard', questions: [{ id: 'q1', ...request }] }];
  const pending = new Set();
  deliverReports(h.manager, h.pi, h.ctx, pending, Date.now(), states);
  assert.equal(h.notifications.length, 0, 'an answerable request must not ask the human to act');
  assert.match(h.statuses.at(-1)[1], /1 subagent waiting for parent review; \/agents to inspect or intervene/);
  deliverReports(h.manager, h.pi, h.ctx, pending, Date.now(), []);
  assert.equal(h.statuses.at(-1)[1], undefined, 'the status clears even with no new reports');
});

test('human-required requests remain visible even when the parent stays silent', () => {
  // A native human-only policy may still let the parent decline or cancel.
  const request = { method: 'select', options: ['Deny once', 'Approve once', 'Cancel turn'],
    humanOnly: true, parentPolicy: { values: ['Deny once', 'Cancel turn'] } };
  const h = harness([{ ...report('human'), status: 'waiting', text: 'Native approval', questionId: 'q2', request }]);
  const states = [
    { id: 'routine', questions: [{ id: 'q1', method: 'confirm', parentPolicy: { confirm: true } }] },
    { id: 'agent', questions: [{ id: 'q2', ...request }] },
  ], pending = new Set();
  deliverReports(h.manager, h.pi, h.ctx, pending, Date.now(), states);
  assert.equal(h.notifications.length, 1, 'native human-only restrictions must not be mistaken for routine parent review');
  assert.match(h.notifications[0][0], /\/agent-reply agent q2/);
  assert.equal(h.notifications[0][1], 'warning');
  assert.match(h.statuses.at(-1)[1], /1 child request needs your decision: \/agent-reply agent q2/);
  h.entries.push({ type: 'custom_message', ...h.sent[0].message });
  deliverReports(h.manager, h.pi, h.ctx, pending, Date.now(), states);
  assert.equal(h.notifications.length, 1, 'persisted delivery must not prompt the human twice');
  assert.match(h.statuses.at(-1)[1], /needs your decision/, 'receipt is not resolution');
  deliverReports(h.manager, h.pi, h.ctx, pending, Date.now(), []);
  assert.equal(h.statuses.at(-1)[1], undefined);
});

test('waiting reaches the next model request while the parent keeps using tools', async () => {
  const h = harness([report('finished'), { ...report('approval'), status: 'waiting', text: 'Inspect this command', questionId: 'q1',
    request: { method: 'confirm', parentPolicy: { confirm: true } } }]);
  const pending = new Set(), requests = [];
  let toolRuns = 0, finishedInFlightTool = false, abortedInFlightTool = false;
  const model = { id: 'offline', name: 'Offline', provider: 'offline', api: 'offline', reasoning: false,
    input: ['text'], contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const agent = new Agent({
    initialState: { model, tools: [{ name: 'parent_work', label: 'Parent work', description: 'Continue local work',
      parameters: { type: 'object', properties: {} }, async execute(_id, _args, signal) {
        if (++toolRuns === 1) {
          deliverReports(h.manager, h.pi, h.ctx, pending);
          await Promise.resolve();
          abortedInFlightTool = signal.aborted;
          finishedInFlightTool = true;
        }
        return { content: [{ type: 'text', text: 'checked' }], details: {} };
      } }] },
    convertToLlm: messages => messages.map(message => message.role === 'custom'
      ? { role: 'user', content: message.content, timestamp: message.timestamp } : message),
    streamFn(_model, context) {
      requests.push([...context.messages]);
      const done = requests.length >= 3;
      const message = { role: 'assistant', api: 'offline', provider: 'offline', model: 'offline', timestamp: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: done ? 'stop' : 'toolUse', content: done ? [{ type: 'text', text: 'done' }]
          : [{ type: 'toolCall', id: `work-${requests.length}`, name: 'parent_work', arguments: {} }] };
      return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: message.stopReason, message }; },
        result: async () => message };
    },
  });
  const host = { agent, get isStreaming() { return agent.state.isStreaming; }, _runAgentPrompt: message => agent.prompt(message) };
  h.pi.sendMessage = (message, options) => { void AgentSession.prototype.sendCustomMessage.call(host, message, options); };
  await agent.prompt('Keep working until the task is done.');
  assert.equal(finishedInFlightTool, true);
  assert.equal(abortedInFlightTool, false, 'steering must not kill the tool already running');
  assert.ok(requests[1].some(message => typeof message.content === 'string' && message.content.includes('Question ID: q1')),
    'a blocked child must be visible before the parent makes another model request, not after it stops');
  assert.ok(requests[1].some(message => typeof message.content === 'string' && message.content.includes('· completed')),
    'a completion sharing the waiting batch must not be lost');
  assert.ok(requests[1].some(message => message.role === 'toolResult' && message.toolCallId === 'work-1'),
    'the in-flight tool result must precede the next model request');
  assert.equal(toolRuns, 2);
  assert.equal(agent.state.messages.filter(message => message.customType === 'cli-subagents-report').length, 1);
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

test('long output previews the original tail and points to the exact result', () => {
  const block = 'VERDICT: BLOCK\nEVIDENCE: src/a.ts:12 — reproduces on the second call\nEVIDENCE: test/x.test.mjs:40 — failing case\nUNVERIFIED: real CLI behaviour';
  const h = harness([{ ...report('long'), notificationId: 'long-result', text: `${'A'.repeat(9000)}\n${block}` }]);
  deliverReports(h.manager, h.pi, h.ctx, new Set());
  const content = h.sent[0].message.content;
  // This short evidence block fits in the preview; arbitrary longer evidence needs the result reader.
  for (const line of block.split('\n')) assert.ok(content.includes(line), `the clip dropped ${line}`);
  assert.match(content, /… \d+ characters omitted …/);
  assert.match(content, /truncated.*subagent_query.*agent/is);
});

for (const status of ['completed', 'waiting']) test(`${status} delivery uses the right queue and replays only lost receipts`, async () => {
  const r = { ...report('original-run'), notificationId: `original-run-${status === 'waiting' ? 'q1' : 'result'}`, status,
    ...(status === 'waiting' ? { questionId: 'q1', request: { method: 'confirm', parentPolicy: { confirm: true } } } : {}) };
  const h = harness([r]), queued = [], calls = [], pending = new Set();
  const mode = status === 'waiting' ? 'steer' : 'followUp';
  const wrong = () => { throw Error(`expected ${mode}`); };
  const host = { isStreaming: true, agent: { followUp: wrong, steer: wrong, [mode]: message => queued.push(message) },
    _runAgentPrompt: async message => queued.push(message) };
  h.pi.sendMessage = (message, options) => { calls.push(AgentSession.prototype.sendCustomMessage.call(host, message, options)); };
  deliverReports(h.manager, h.pi, h.ctx, pending);
  await Promise.all(calls);
  assert.equal(queued.length, 1); assert.equal(h.entries.length, 0, 'queued is not a persisted receipt');
  assert.deepEqual(queued[0].details.ids, [r.notificationId]);
  const original = queued[0].content;
  deliverReports(h.manager, h.pi, h.ctx, pending);
  assert.equal(queued.length, 1);
  // A lost host queue has no receipt. Reopening the parent uses a fresh pending set.
  queued.length = 0; host.isStreaming = false;
  const resumed = new Set();
  deliverReports(h.manager, h.pi, h.ctx, resumed);
  await Promise.all(calls);
  assert.equal(queued.length, 1); assert.equal(queued[0].content, original);
  assert.deepEqual(queued[0].details.ids, [r.notificationId]);
  h.entries.push({ type: 'custom_message', ...queued[0] });
  deliverReports(h.manager, h.pi, h.ctx, resumed);
  assert.equal(resumed.size, 0);
  deliverReports(h.manager, h.pi, h.ctx, new Set());
  assert.equal(queued.length, 1, 'persisted receipts prevent replay on another reopen');
});

test('no-session parent must fail closed rather than create unowned agents', async () => {
  const { parentManager } = await import('../dist/index.js');
  assert.throws(() => parentManager({ sessionManager: { getSessionFile: () => undefined } }, { command: 'pi', args: [] }), /persistent parent session/);
});
