import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '../dist/codex-adapter.js';
import { waitUntil } from '../dist/storage.js';
const fixture = fileURLToPath(new URL('./fixtures/codex.mjs', import.meta.url));
const output = path.resolve('.test-output'); fs.mkdirSync(output, { recursive: true });
function setup(t, overrides = {}) {
  const cwd = fs.mkdtempSync(path.join(output, 'codex-protocol-'));
  const home = path.join(cwd, 'native-home'); fs.mkdirSync(home); fs.writeFileSync(path.join(home, 'fixture-home'), '');
  const spec = { version: 2, cli: 'codex', id: 'test-instance', parentFile: path.join(cwd, 'parent.jsonl'), cwd, codexHome: home,
    roleName: 'worker', role: { cli: 'codex', description: 'test', instructions: 'Do only the assigned work.', model: 'gpt-6-luna', effort: 'high' },
    launch: { command: process.execPath, args: [fixture] }, createdAt: Date.now(), ...overrides };
  const clients = [];
  t.after(async () => { for (const c of clients) await c.stop(); });
  function client(session, flags = []) {
    const events = [];
    const c = new CodexAdapter({ spec: { ...spec, launch: { ...spec.launch, args: [...spec.launch.args, ...flags] } }, session,
      logFile: path.join(cwd, `events-${clients.length}.jsonl`), onEvent: e => events.push(e), requestTimeout: 1500 });
    clients.push(c); return { c, events };
  }
  const requests = () => fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return { cwd, home, spec, client, requests };
}
const settled = events => waitUntil('adapter terminal event', () => events.find(e => e.type === 'settled'), 5000);

test('Codex correlates fast events, keeps native IDs distinct, and resumes the exact thread', async t => {
  const { client, requests, home } = setup(t);
  const first = client(); const original = await first.c.ready();
  assert.equal(original.cli, 'codex'); assert.equal(original.codexHome, home);
  assert.notEqual(original.threadId, original.sessionId); assert.equal(original.sessionFile, undefined);
  await first.c.start('REMEMBER alpha');
  assert.deepEqual((await settled(first.events)).text, 'OK');
  assert.equal((await first.c.end()).exit.code, 0);
  const next = client(original); assert.deepEqual(await next.c.ready(), original);
  await next.c.start('RECALL'); assert.equal((await settled(next.events)).text, 'alpha');
  assert.equal((await next.c.end()).forced, false);
  const calls = requests();
  assert.deepEqual(calls.slice(0, 3).map(c => c.method), ['initialize', 'initialized', 'thread/start']);
  assert.equal(calls.filter(c => c.method === 'thread/start').length, 1);
  assert.equal(calls.find(c => c.method === 'thread/start').params.allowProviderModelFallback, false);
  assert.equal(calls.find(c => c.method === 'thread/resume').params.threadId, original.threadId);
  assert.equal(calls.find(c => c.method === 'turn/start').params.effort, 'high');
  assert.ok(calls.every(c => !['thread/delete', 'thread/archive', 'thread/fork'].includes(c.method)));
});

test('Codex preflight reads only original metadata, submits no turn and reaps its process', async t => {
  const { client, requests, home } = setup(t);
  const first = client(); const original = await first.c.ready(); await first.c.end();
  const before = fs.readFileSync(path.join(home, `${original.threadId}.json`));
  const check = client(original); await check.c.inspectSession();
  assert.equal((await check.c.closed).code, 0);
  assert.deepEqual(requests().slice(3).map(r => r.method), ['initialize', 'initialized', 'thread/read']);
  assert.equal(requests().at(-1).params.includeTurns, false);
  assert.equal(requests().at(-1).params.threadId, original.threadId);
  assert.deepEqual(fs.readFileSync(path.join(home, `${original.threadId}.json`)), before);
  assert.deepEqual(check.events, []);
});

test('Codex preflight refuses foreign, missing, active, malformed and timed-out native threads', async t => {
  const { client, home, requests } = setup(t);
  const first = client(); const original = await first.c.ready(); await first.c.end();
  const file = path.join(home, `${original.threadId}.json`), saved = JSON.parse(fs.readFileSync(file));
  for (const change of [{ id: 'foreign' }, { sessionId: 'foreign' }, { cwd: path.dirname(saved.cwd) }, { cwd: null }, { ephemeral: true }, { status: { type: 'active' } }, { status: { type: 'systemError' } }, { status: {} }]) {
    fs.writeFileSync(file, JSON.stringify({ ...saved, ...change }));
    const check = client(original);
    await assert.rejects(check.c.inspectSession(), /persistent|different|directory|idle|status/i);
    assert.equal((await check.c.closed).code, 0);
  }
  fs.unlinkSync(file);
  const missing = client(original); await assert.rejects(missing.c.inspectSession(), /missing/i);
  assert.equal((await missing.c.closed).code, 0);
  fs.writeFileSync(file, JSON.stringify(saved));
  const timeout = client(original, ['--read-timeout']); await assert.rejects(timeout.c.inspectSession(), /timed out/i);
  assert.equal((await timeout.c.closed).code, 0);
  assert.equal(requests().filter(r => r.method === 'thread/start').length, 1);
  assert.equal(requests().filter(r => r.method === 'turn/start' || r.method === 'thread/resume').length, 0);
});

test('Codex ignores foreign thread/turn completion and does not double cumulative text', async t => {
  const { client } = setup(t); const { c, events } = client();
  await c.ready(); await c.start('FOREIGN_EVENTS');
  const end = await settled(events); assert.equal(end.status, 'completed'); assert.equal(end.text, 'CURRENT');
  assert.equal(events.filter(e => e.type === 'settled').length, 1);
  await assert.rejects(c.send('TOO_LATE', 'steer'), /no active turn/);
});

test('Codex reports the final answer rather than earlier commentary', async t => {
  const { client } = setup(t); const { c, events } = client();
  await c.ready(); await c.start('COMMENTARY');
  assert.equal((await settled(events)).text, 'FINAL');
});

test('Codex preserves Unicode JSONL framing and backs up a missing summary once by exact turn', async t => {
  const { client, requests } = setup(t);
  const first = client(); await first.c.ready(); await first.c.start('UNICODE');
  assert.equal((await settled(first.events)).text, 'A\u2028B\u2029雪'); await first.c.end();
  const next = client(); await next.c.ready(); await next.c.start('BACKFILL');
  assert.equal((await settled(next.events)).text, 'RECOVERED'); await next.c.end();
  assert.equal(requests().filter(c => c.method === 'thread/read').length, 1);
});

test('Codex steer uses the active turn and rejects followUp without sending another turn/start', async t => {
  const { client, requests } = setup(t); const { c, events } = client();
  const session = await c.ready(); await c.start('HOLD');
  assert.equal(events.some(e => e.type === 'settled'), false);
  await assert.rejects(c.send('afterwards', 'followUp'), /followUp.*not supported/i);
  await c.send('STEERED', 'steer'); assert.equal((await settled(events)).text, 'STEERED');
  const steer = requests().find(c => c.method === 'turn/steer');
  assert.equal(steer.params.threadId, session.threadId); assert.ok(steer.params.expectedTurnId);
  assert.equal(requests().filter(c => c.method === 'turn/start').length, 1);
});

test('Codex accepts a fast steer completion before the steer response', async t => {
  const { client } = setup(t); const { c, events } = client();
  await c.ready(); await c.start('HOLD');
  await c.send('FAST_STEER', 'steer');
  assert.equal((await settled(events)).text, 'FAST_STEER');
});

test('Codex stop waits for interrupted completion and keeps the native thread', async t => {
  const { client, home, requests } = setup(t); const { c, events } = client();
  const session = await c.ready(); await c.start('HOLD');
  const end = await c.stop(); assert.equal(end.exit.code, 0); assert.equal(end.forced, false);
  assert.equal((await settled(events)).status, 'stopped');
  assert.ok(fs.existsSync(path.join(home, `${session.threadId}.json`)));
  assert.equal(requests().find(c => c.method === 'turn/interrupt').params.threadId, session.threadId);
});

test('Codex refuses mismatched thread or session identity before submitting a new task', async t => {
  const { client, requests } = setup(t);
  const first = client(); const session = await first.c.ready(); await first.c.end();
  for (const flag of ['--wrong-resume', '--wrong-session']) {
    const next = client(session, [flag]);
    await assert.rejects(next.c.ready(), /different.*session|different.*thread/i); await next.c.end();
  }
  assert.equal(requests().filter(c => c.method === 'turn/start').length, 0);
  assert.equal(requests().filter(c => c.method === 'thread/start').length, 1);
});

test('Codex explicit rejection, model failure, timeout, invalid stdout and early exit are not successes', async t => {
  const { client } = setup(t);
  for (const message of ['REJECT', 'FAIL', 'TIMEOUT', 'NOISE', 'CRASH', 'EARLY_EXIT']) {
    const { c, events } = client(); await c.ready();
    if (message === 'FAIL') { await c.start(message); assert.match((await settled(events)).error, /fixture model failure/); }
    else await assert.rejects(c.start(message), /rejected|uncertain|JSON|exited|record/i);
    assert.ok(!events.some(e => e.type === 'settled' && e.status === 'completed'), message);
    await c.stop();
  }
});

test('Codex command/file approvals return only one-action decisions for a scoped request', async t => {
  const { client, requests } = setup(t);
  for (const [task, answer, decision, result] of [
    ['APPROVAL', { confirmed: true }, 'accept', 'ALLOW'],
    ['APPROVAL_FILE', { confirmed: false }, 'decline', 'DENY'],
    ['APPROVAL_FILE_MOVE', { confirmed: false }, 'decline', 'DENY'],
    ['APPROVAL_STRING_ID', { cancelled: true }, 'cancel', 'CANCELLED'],
  ]) {
    const { c, events } = client(); await c.ready(); await c.start(task);
    const q = await waitUntil('Codex approval', () => events.find(e => e.type === 'question')?.question);
    assert.equal(q.method, 'confirm'); assert.match(q.message, /fixture/);
    if (task.startsWith('APPROVAL_FILE')) {
      assert.match(q.message, /work\.txt/); assert.match(q.message, /"type":"update"/);
      assert.ok(!q.message.includes('[object Object]'));
      if (task.includes('MOVE')) assert.match(q.message, /renamed\.txt/);
      else assert.match(q.message, /"move_path":null/);
    }
    await c.reply({ type: 'reply', id: q.id, ...answer });
    assert.equal((await settled(events)).text, result);
    const incoming = requests().filter(r => !r.method && r.result?.decision === decision);
    assert.ok(incoming.length >= 1); assert.equal(incoming.at(-1).result.decision, decision);
    assert.equal(events.filter(e => e.type === 'resolved' && e.id === q.id).length, 1);
    await c.end();
  }
  assert.ok(!requests().some(c => ['acceptForSession', 'acceptWithExecpolicyAmendment'].includes(c.result?.decision)));
});

test('Codex accept/cancel-only commands expose explicit choices without a persistent grant', async t => {
  const { client, requests } = setup(t);
  for (const [answer, native, status] of [
    [{ value: 'Approve once' }, 'accept', 'completed'],
    [{ value: 'Cancel turn' }, 'cancel', 'stopped'],
    [{ cancelled: true }, 'cancel', 'stopped'],
  ]) {
    const { c, events } = client(); await c.ready(); await c.start('APPROVAL_ACCEPT_CANCEL');
    const q = events.find(e => e.type === 'question')?.question;
    assert.ok(q, 'native accept/cancel must remain answerable without a decline option');
    assert.equal(q.method, 'select'); assert.deepEqual(q.options, ['Approve once', 'Cancel turn']);
    assert.match(q.message, /cancel.*end.*turn/i);
    for (const invalid of [{ confirmed: false }, { value: 'acceptForSession' }, { value: 'Apply policy amendment' }, { value: 'Approve once', cancelled: true }]) {
      await assert.rejects(c.reply({ type: 'reply', id: q.id, ...invalid }), /choice|option|explicit/i);
    }
    const before = requests().filter(r => !r.method).length;
    await c.reply({ type: 'reply', id: q.id, ...answer });
    assert.equal((await settled(events)).status, status);
    const decisions = requests().filter(r => !r.method).slice(before);
    assert.equal(decisions.length, 1); assert.equal(decisions[0].result.decision, native);
    await assert.rejects(c.reply({ type: 'reply', id: q.id, ...answer }), /answered|pending/);
    await c.end();
  }
  assert.ok(requests().filter(r => !r.method).every(r => ['accept', 'cancel'].includes(r.result?.decision)));
});

test('Codex distinguishes callbacks with the same itemId and rejects duplicate/expired answers', async t => {
  const { client, requests } = setup(t);
  const { c, events } = client(); await c.ready(); await c.start('APPROVAL_DOUBLE');
  await waitUntil('two requests', () => events.filter(e => e.type === 'question').length === 2);
  const [first, second] = events.filter(e => e.type === 'question').map(e => e.question);
  assert.notEqual(first.id, second.id);
  await c.reply({ type: 'reply', id: second.id, confirmed: false });
  await assert.rejects(c.reply({ type: 'reply', id: second.id, confirmed: true }), /ended|answered|pending/i);
  await c.reply({ type: 'reply', id: first.id, confirmed: false });
  assert.equal((await settled(events)).text, 'DENY');
  assert.deepEqual(requests().filter(r => !r.method && r.result?.decision).map(r => r.id), [18, 17]);
});

test('Codex auto-resolved approval cannot be answered, unsupported or broad approvals fail closed', async t => {
  const { client, requests } = setup(t);
  const auto = client(); await auto.c.ready(); await auto.c.start('APPROVAL_AUTO_RESOLVE');
  const q = await waitUntil('auto approval', () => auto.events.find(e => e.type === 'question')?.question);
  await waitUntil('resolved approval', () => auto.events.find(e => e.type === 'resolved' && e.id === q.id));
  await assert.rejects(auto.c.reply({ type: 'reply', id: q.id, confirmed: true }), /ended|pending/i);
  assert.equal((await settled(auto.events)).text, 'AUTO-RESOLVED'); await auto.c.end();
  for (const task of ['APPROVAL_NO_DETAILS', 'APPROVAL_FILE_GRANT_ROOT', 'APPROVAL_WRITE_STDIN', 'APPROVAL_WRONG_SCOPE', 'APPROVAL_EXTRA_PERMISSIONS', 'APPROVAL_EXTRA_PERMISSIONS_NETWORK', 'APPROVAL_ONLY_SESSION']) {
    const { c, events } = client(); await c.ready(); await c.start(task);
    assert.equal((await settled(events)).status, 'failed', task);
    assert.equal(events.some(e => e.type === 'question'), false, task);
    await c.stop();
  }
  assert.ok(!requests().some(r => r.result?.decision === 'accept'));
});

test('Codex rejects approvals without a valid active turn even when both IDs match', async t => {
  const { client, requests } = setup(t);
  for (const params of [{}, { activeTurnId: '', turnId: '' }, { activeTurnId: ' ', turnId: ' ' },
    { activeTurnId: 'valid-turn' }, { activeTurnId: 'valid-turn', turnId: '' }, { activeTurnId: 'valid-turn', turnId: 'foreign' }]) {
    const { c, events } = client(); await c.ready();
    c.child.stdin.write(JSON.stringify({ method: 'fixture/approvalScope', params }) + '\n');
    const event = await waitUntil('approval rejected or exposed', () => events.find(e => e.type === 'settled' || e.type === 'question'));
    assert.equal(event.type, 'settled', JSON.stringify(params));
    assert.equal(event.status, 'failed');
    assert.equal(events.some(e => e.type === 'question'), false);
    await c.end();
  }
  assert.ok(requests().filter(r => r.id === 17 && !r.method).every(r => r.error), 'unscoped requests receive no approval decision');
});

test('Codex rechecks malformed pending scope before writing an approval response', async t => {
  const { client, requests } = setup(t); const { c, events } = client();
  await c.ready(); await c.start('APPROVAL');
  const q = await waitUntil('valid approval', () => events.find(e => e.type === 'question')?.question);
  // Fault injection at the reply boundary: matching absent/empty IDs must never authorize a write.
  const pending = c.approvals.get(q.id), originalTurn = pending.turnId;
  try {
    for (const turnId of [undefined, '', ' ']) {
      pending.turnId = turnId; c.activeTurn = turnId;
      await assert.rejects(c.reply({ type: 'reply', id: q.id, confirmed: true }), /pending|turn|scope/i);
      assert.equal(requests().filter(r => !r.method && r.id === 17).length, 0);
    }
  } finally { pending.turnId = originalTurn; c.activeTurn = originalTurn; }
  await c.reply({ type: 'reply', id: q.id, confirmed: false });
  assert.equal((await settled(events)).text, 'DENY');
});

test('Codex does not send decisions excluded by the native server', async t => {
  const { client, requests } = setup(t); const { c, events } = client();
  await c.ready(); await c.start('APPROVAL_NO_CANCEL');
  const q = await waitUntil('Codex restricted approval', () => events.find(e => e.type === 'question')?.question);
  await assert.rejects(c.reply({ type: 'reply', id: q.id, cancelled: true }), /not offered|unavailable/i);
  assert.equal(requests().filter(r => !r.method && r.id === 17).length, 0);
  await c.reply({ type: 'reply', id: q.id, confirmed: false });
  assert.equal((await settled(events)).text, 'DENY');
});

test('Codex approval response without server resolution cannot be submitted a second time', async t => {
  const { client, requests } = setup(t); const { c, events } = client(undefined, ['--no-resolved']);
  await c.ready(); await c.start('APPROVAL');
  const q = await waitUntil('Codex approval', () => events.find(e => e.type === 'question')?.question);
  await assert.rejects(c.reply({ type: 'reply', id: q.id, confirmed: false }), /uncertain|timed out/i);
  await assert.rejects(c.reply({ type: 'reply', id: q.id, confirmed: true }), /answered|pending/i);
  assert.equal(requests().filter(r => !r.method && r.id === 17).length, 1);
  await c.stop();
});
