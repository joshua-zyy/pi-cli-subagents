import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CodexAdapter } from '../dist/codex-adapter.js';
import { waitUntil } from '../dist/storage.js';
import { tempDir } from './helpers/tmp.mjs';
const fixture = fileURLToPath(new URL('./fixtures/codex.mjs', import.meta.url));
function setup(t, overrides = {}) {
  const cwd = tempDir('codex-protocol');
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
const runSettled = (events, runId) => waitUntil('run terminal', () => events.find(e => e.type === 'settled' && e.runId === runId), 5000);

test('Codex role without a model inherits the native default and is not pinned against provider fallback', async t => {
  const { client, requests, spec } = setup(t, { role: { cli: 'codex', description: 'test', instructions: 'Do only the assigned work.' } });
  const { c, events } = client(); const session = await c.ready();
  await c.start('REMEMBER inherit'); assert.equal((await settled(events)).text, 'OK');
  const start = requests().find(r => r.method === 'thread/start');
  assert.equal('model' in start.params, false, 'no model is sent when the role omits one');
  assert.equal('allowProviderModelFallback' in start.params, false, 'fallback policy is left to the native configuration');
  assert.equal(JSON.parse(fs.readFileSync(path.join(session.codexHome, session.threadId + '.json'))).model, 'fixture-default-model');
  assert.equal(requests().find(r => r.method === 'turn/start').params.effort, undefined);
  assert.equal(spec.role.model, undefined); await c.end();
});

test('Codex resident resets each round, keeps PID/session and rejects stale terminal events', async t => {
  const { client, requests } = setup(t); const { c, events } = client(); const session = await c.ready(), pid = c.pid;
  assert.equal(c.resident, true);
  await c.start('REMEMBER alpha', 'one'); assert.equal((await runSettled(events, 'one')).text, 'OK');
  const saved = JSON.parse(fs.readFileSync(path.join(session.codexHome, session.threadId + '.json'))).turns[0];
  const firstCount = events.length;
  await c.start('HOLD', 'two');
  c.child.stdin.write(JSON.stringify({ method: 'fixture/emit', params: { records: [
    { method: 'turn/started', params: { threadId: session.threadId, turn: saved } },
    { method: 'turn/completed', params: { threadId: session.threadId, turn: saved } },
  ] } }) + '\n');
  await c.send('RECALL', 'steer'); assert.equal((await runSettled(events, 'two')).text, 'alpha');
  assert.equal(c.pid, pid);
  assert(events.slice(0, firstCount).every(e => e.runId === 'one'));
  assert(events.slice(firstCount).every(e => e.runId === 'two'));
  await c.start('BACKFILL', 'three'); assert.equal((await runSettled(events, 'three')).text, 'RECOVERED');
  assert.equal(requests().filter(r => r.method === 'thread/start').length, 1);
  assert.equal(events.filter(e => e.type === 'settled').length, 3);
});

test('Codex interrupt captures the pending turn, is idempotent and clears old questions', async t => {
  const { client, requests } = setup(t); const { c, events } = client(undefined, ['--delay-start']); await c.ready();
  const start = c.start('QUESTION', 'one');
  const a = c.interrupt(), b = c.interrupt();
  await assert.rejects(c.start('wrong', 'two'), /interrupt|active|ready/i);
  await assert.rejects(c.send('wrong', 'steer'), /interrupt/i);
  await Promise.all([start, a, b]);
  assert.equal((await runSettled(events, 'one')).status, 'stopped');
  const q = events.find(e => e.type === 'question'); assert(q);
  await assert.rejects(c.reply({ type: 'reply', id: q.question.id, cancelled: true }), /pending|answered/i);
  assert(events.some(e => e.type === 'resolved' && e.runId === 'one'));
  assert.equal(c.child.exitCode, null);
  assert.equal(requests().filter(r => r.method === 'turn/interrupt').length, 1);
  await c.start('REMEMBER next', 'two'); assert.equal((await runSettled(events, 'two')).text, 'OK');
});

test('Codex blocks new rounds while final text is being recovered from the captured turn', async t => {
  const { client, home, requests } = setup(t); const { c, events } = client(undefined, ['--hold-read']); await c.ready();
  await c.start('BACKFILL', 'one');
  await waitUntil('native backfill request', () => requests().some(r => r.method === 'thread/read'));
  await assert.rejects(c.start('wrong', 'two'), /ready|active/i);
  fs.writeFileSync(path.join(home, 'release-read'), '');
  assert.equal((await runSettled(events, 'one')).text, 'RECOVERED');
  await c.start('FAIL', 'two');
  const result = await runSettled(events, 'two'); assert.equal(result.status, 'failed'); assert.equal(result.text, '');
});

test('Codex interrupt acknowledgement without terminal and timeout poison the runtime', async t => {
  for (const flag of ['--ignore-interrupt', '--ack-interrupt-only']) {
    const { client } = setup(t); const { c, events } = client(undefined, [flag]); const session = await c.ready(); await c.start('HOLD', 'one');
    await assert.rejects(c.interrupt(), /uncertain|timed out/i);
    const turnId = c.activeTurn;
    c.child.stdin.write(JSON.stringify({ method: 'fixture/emit', params: { records: [
      { method: 'turn/completed', params: { threadId: session.threadId, turn: { id: turnId, status: 'interrupted' } } },
    ] } }) + '\n');
    await runSettled(events, 'one');
    await assert.rejects(c.start('wrong', 'two'), /uncertain|poison|stop|release/i);
    await assert.rejects(c.send('wrong', 'steer'), /uncertain|poison|stop|release/i);
    await c.stop();
  }
});

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

test('Codex role mode is sent as one approval/sandbox preset and unset roles inherit theirs', async t => {
  const role = { cli: 'codex', description: 'test', instructions: 'Do only the assigned work.', model: 'gpt-6-luna' };
  const full = setup(t, { role: { ...role, mode: 'full-access' } });
  const first = full.client(); const original = await first.c.ready(); await first.c.start('REMEMBER alpha');
  await settled(first.events); await first.c.end();
  const resumed = full.client(original); await resumed.c.ready(); await resumed.c.end();
  const calls = full.requests();
  const start = calls.find(c => c.method === 'thread/start').params, resume = calls.find(c => c.method === 'thread/resume').params;
  assert.deepEqual([start.approvalPolicy, start.sandbox], ['never', 'danger-full-access']);
  assert.deepEqual([resume.approvalPolicy, resume.sandbox], ['never', 'danger-full-access'], 'a continuation keeps the role posture');

  const narrow = setup(t, { role: { ...role, mode: 'read-only' } });
  const plain = narrow.client(); await plain.c.ready(); await plain.c.end();
  const params = narrow.requests().find(c => c.method === 'thread/start').params;
  assert.deepEqual([params.approvalPolicy, params.sandbox], ['on-request', 'read-only']);

  const unset = setup(t, { role });
  const inherited = unset.client(); await inherited.c.ready(); await inherited.c.end();
  const defaults = unset.requests().find(c => c.method === 'thread/start').params;
  assert.ok(!('approvalPolicy' in defaults) && !('sandbox' in defaults), 'no mode means the native configuration stays in charge');
});

test('Codex Default question override uses process config on initial launch and resume without changing permissions', async t => {
  for (const value of [undefined, true, false]) {
    const role = { cli: 'codex', description: 'test', instructions: 'Keep the task scope.', model: 'gpt-6-luna', effort: 'high', mode: 'read-only',
      ...(value === undefined ? {} : { defaultModeQuestions: value }) };
    const { client, requests, home } = setup(t, { role });
    const config = path.join(home, 'config.toml'); fs.writeFileSync(config, '# native configuration is not rewritten\n');
    let original;
    for (const resume of [false, true]) {
      const { c, events } = client(resume ? original : undefined);
      const session = await c.ready();
      if (resume) assert.deepEqual(session, original); else original = session;
      await c.start('DEFAULT_QUESTION');
      if (value === true) {
        const question = await waitUntil('Default question', () => events.find(e => e.type === 'question'), 1500);
        assert.equal(question.question.method, 'form');
        await c.reply({ type: 'reply', id: question.question.id, cancelled: true });
        assert.equal((await settled(events)).text, '{}');
      } else {
        assert.equal((await settled(events)).text, 'DEFAULT_QUESTIONS_DISABLED');
        assert.ok(!events.some(e => e.type === 'question'));
      }
      assert.equal((await c.end()).exit.code, 0);
    }
    const calls = requests();
    const args = [...(value === undefined ? [] : ['-c', 'features.default_mode_request_user_input=' + value]), 'app-server', '--listen', 'stdio://'];
    assert.deepEqual(calls.filter(r => r.method === 'initialize').map(r => r.launchArgs), [args, args]);
    for (const call of calls.filter(r => ['thread/start', 'thread/resume'].includes(r.method))) {
      assert.deepEqual([call.params.model, call.params.approvalPolicy, call.params.sandbox], ['gpt-6-luna', 'on-request', 'read-only']);
    }
    for (const call of calls.filter(r => r.method === 'turn/start')) {
      assert.equal(call.params.effort, 'high');
      assert.equal(Object.hasOwn(call.params, 'collaborationMode'), false, 'enabling Default questions never switches to Plan');
    }
    assert.equal(fs.readFileSync(config, 'utf8'), '# native configuration is not rewritten\n');
  }
});

test('Codex refuses non-boolean Default question settings before starting a process', t => {
  const role = { cli: 'codex', description: 'test', instructions: 'Task.', model: 'm' };
  for (const value of ['true', 'false', null, 1]) {
    const { client, home } = setup(t, { role: { ...role, defaultModeQuestions: value } });
    assert.throws(() => client(), /defaultModeQuestions/);
    assert.equal(fs.existsSync(path.join(home, 'requests.jsonl')), false);
  }
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

test('Codex auto-resolved approval cannot be answered; unsupported or broad approvals are declined per request and the turn continues', async t => {
  const { client, requests } = setup(t);
  const auto = client(); await auto.c.ready(); await auto.c.start('APPROVAL_AUTO_RESOLVE');
  const q = await waitUntil('auto approval', () => auto.events.find(e => e.type === 'question')?.question);
  await waitUntil('resolved approval', () => auto.events.find(e => e.type === 'resolved' && e.id === q.id));
  await assert.rejects(auto.c.reply({ type: 'reply', id: q.id, confirmed: true }), /ended|pending/i);
  assert.equal((await settled(auto.events)).text, 'AUTO-RESOLVED'); await auto.c.end();
  for (const task of ['APPROVAL_NO_DETAILS', 'APPROVAL_FILE_GRANT_ROOT', 'APPROVAL_WRITE_STDIN', 'APPROVAL_WRONG_SCOPE', 'APPROVAL_EXTRA_PERMISSIONS', 'APPROVAL_EXTRA_PERMISSIONS_NETWORK', 'APPROVAL_ONLY_SESSION']) {
    const { c, events } = client(); await c.ready(); await c.start(task);
    const result = await settled(events); assert.equal(result.status, 'completed', task); assert.equal(result.text, 'DENY', task);
    assert.equal(events.some(e => e.type === 'question'), false, task);
    assert(events.some(e => e.type === 'activity' && /^interaction refused: item\/(commandExecution|fileChange)\/requestApproval$/.test(e.detail)), task);
    assert.equal(c.child.exitCode, null, `${task}: a refused approval must not release the runtime`); await c.end();
  }
  const written = requests().filter(r => !r.method && r.result?.decision);
  assert.equal(written.filter(r => r.result.decision === 'decline').length, 7, 'every refused approval received a native decline');
  assert.ok(!written.some(r => r.result.decision === 'accept'));
});

test('Codex declines approvals without a valid active turn and keeps the runtime usable', async t => {
  const { client, requests } = setup(t);
  for (const params of [{}, { activeTurnId: '', turnId: '' }, { activeTurnId: ' ', turnId: ' ' },
    { activeTurnId: 'valid-turn' }, { activeTurnId: 'valid-turn', turnId: '' }, { activeTurnId: 'valid-turn', turnId: 'foreign' }]) {
    const { c, events } = client(); await c.ready(); const before = requests().filter(r => r.id === 17 && !r.method).length;
    c.child.stdin.write(JSON.stringify({ method: 'fixture/approvalScope', params }) + '\n');
    await waitUntil('scope refusal written', () => requests().filter(r => r.id === 17 && !r.method).length === before + 1);
    assert(events.some(e => e.type === 'activity' && e.detail === 'interaction refused: item/commandExecution/requestApproval'), JSON.stringify(params));
    assert.equal(events.some(e => e.type === 'question' || e.type === 'settled'), false, JSON.stringify(params));
    assert.equal(c.child.exitCode, null); await c.end();
  }
  assert.ok(requests().filter(r => r.id === 17 && !r.method).every(r => r.result?.decision === 'decline'), 'unscoped approvals receive a native decline, never an acceptance');
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

test('Codex task questions preserve fields and write one native answer map, not an approval', async t => {
  const { client, requests } = setup(t);
  for (const [task, answer] of [
    ['QUESTION', { answers: { checks: ['Unit'], context: ['Keep commas, whitespace, and 雪 exactly.'] } }],
    ['QUESTION', { answers: { checks: [], context: [] } }],
    ['QUESTION_NONBLOCKING_STRING_ID', { cancelled: true }],
  ]) {
    const { c, events } = client(); await c.ready(); await c.start(task);
    const q = events.find(e => e.type === 'question')?.question;
    assert(q, 'native task questions must be presented, not failed as unsupported');
    assert.equal(q.method, 'form'); assert.equal(q.kind, 'question');
    assert.deepEqual(q.parentPolicy, { answers: true }); assert.equal(q.humanOnly, false);
    assert.equal(q.isBlocking, !task.includes('NONBLOCKING'));
    assert.deepEqual(q.fields.map(f => f.id), ['checks','context']);
    assert.equal(q.fields[0].options[0].description, 'Focused checks');
    assert.equal(q.fields[1].allowOther, true); assert.equal(q.expiresAt, undefined, 'deprecated autoResolutionMs is not a client timer');
    const before = requests().filter(r => !r.method).length;
    for (const invalid of [{ confirmed: true }, { value: 'Unit' }, { answers: { checks: ['Unit'] } },
      { answers: { checks: ['acceptForSession'], context: ['x'] } }, { answers: answer.answers, cancelled: true }]) {
      if (invalid.answers === undefined && invalid.cancelled) continue;
      await assert.rejects(c.reply({ type: 'reply', id: q.id, ...invalid }), /answer|field|choice|response|form/i);
    }
    assert.equal(requests().filter(r => !r.method).length, before, 'invalid answers do not reach the CLI');
    await c.reply({ type: 'reply', id: q.id, ...answer });
    const wire = requests().filter(r => !r.method).slice(before);
    assert.equal(wire.length, 1); assert.equal(wire[0].id, task.includes('STRING_ID') ? '17' : 17);
    const expected = answer.cancelled ? {} : Object.fromEntries(Object.entries(answer.answers).map(([id, answers]) => [id, { answers }]));
    assert.deepEqual(wire[0].result, { answers: expected });
    assert.deepEqual(JSON.parse((await settled(events)).text), expected);
    assert.equal(events.filter(e => e.type === 'resolved' && e.id === q.id).length, 1);
    await assert.rejects(c.reply({ type: 'reply', id: q.id, ...answer }), /answered|pending/);
    await c.end();
  }
});

test('Codex does not reclassify MCP approval forms or action-owned input as task questions', async t => {
  const { client, requests } = setup(t);
  for (const task of ['QUESTION_MCP_APPROVAL', 'QUESTION_MCP_ITEM']) {
    const { c, events } = client(); await c.ready(); await c.start(task);
    assert.equal(events.some(e => e.type === 'question'), false, 'do not publish agent-answerable approval forms');
    const result = await settled(events); assert.equal(result.status, 'completed', task); assert.equal(result.text, '{}', task);
    assert(events.some(e => e.type === 'activity' && e.detail === 'interaction refused: item/tool/requestUserInput'), task);
    assert.equal(c.child.exitCode, null, task); await c.end();
  }
  const replies = requests().filter(r => !r.method);
  assert.equal(replies.length, 2); assert(replies.every(r => !r.error && JSON.stringify(r.result) === '{"answers":{}}'), 'an empty answer set reaches the CLI; no answer maps or permission grants');
});

test('Codex MCP prefix approvals expose only single-action choices and return one correlated native answer', async t => {
  const { client, requests, home } = setup(t);
  for (const [task, answer, native] of [
    ['MCP_APPROVAL', { value: 'Allow' }, 'Allow'],
    ['MCP_APPROVAL_STRING_ID', { value: 'Cancel' }, 'Cancel'],
    ['MCP_APPROVAL_LEGACY', { cancelled: true }, 'Cancel'],
    ['MCP_APPROVAL_OMITTED_FLAGS', { value: 'Cancel' }, 'Cancel'],
  ]) {
    const { c, events } = client(); await c.ready(); await c.start(task);
    const q = events.find(e => e.type === 'question')?.question;
    assert(q, 'a correlated native MCP approval must not fail the entire run');
    assert.equal(q.method, 'select'); assert.notEqual(q.kind, 'question'); assert.equal(q.fields, undefined);
    assert.deepEqual(q.options, ['Allow', 'Cancel']); assert.deepEqual(q.parentPolicy, { values: ['Allow', 'Cancel'] });
    assert.match(q.message, /fixture-only\.txt/); assert.match(q.message, /fixture/); assert.match(q.message, /write/);
    const before = requests().filter(r => !r.method).length;
    for (const invalid of [{ value: 'Allow for this session' }, { value: "Allow and don't ask me again" },
      { answers: { mcp_tool_call_approval_mcp_call: ['Allow'] } }, { confirmed: true }, { value: 'Allow', cancelled: true }]) {
      await assert.rejects(c.reply({ type: 'reply', id: q.id, ...invalid }), /MCP|choice|decision/i);
    }
    assert.equal(requests().filter(r => !r.method).length, before);
    await c.reply({ type: 'reply', id: q.id, ...answer });
    assert.equal((await settled(events)).text, `MCP:${native}`);
    assert.deepEqual(requests().filter(r => !r.method).slice(before).map(({ id, result }) => ({ id, result })),
      [{ id: task.includes('STRING_ID') ? '17' : 17, result: { answers: { 'mcp_tool_call_approval_mcp-call': { answers: [native] } } } }]);
    await assert.rejects(c.reply({ type: 'reply', id: q.id, ...answer }), /pending|answered/);
    assert.equal(events.filter(e => e.type === 'resolved' && e.id === q.id).length, 1);
    await c.end();
  }
  assert.equal(fs.readFileSync(path.join(home, 'mcp-effect.txt'), 'utf8'), '1');
  assert.equal(fs.existsSync(path.join(home, 'mcp-grants.jsonl')), false);
});

test('Codex MCP prefix approvals with foreign, old, missing or completed call associations are cancelled natively, never approved', async t => {
  const { client, requests } = setup(t);
  for (const suffix of ['WRONG_THREAD', 'WRONG_TURN', 'WRONG_ITEM', 'WRONG_KEY', 'MISSING_ITEM', 'COMPLETED_ITEM', 'OLD_ITEM', 'NONBLOCKING']) {
    const { c, events } = client(); await c.ready(); await c.start(`MCP_APPROVAL_${suffix}`);
    assert.equal(events.some(e => e.type === 'question'), false, suffix);
    const result = await settled(events); assert.equal(result.status, 'stopped', suffix); assert.equal(result.text, 'MCP:Cancel', suffix);
    assert(events.some(e => e.type === 'activity' && /^interaction refused: (item\/)?tool\/requestUserInput$/.test(e.detail)), suffix);
    assert.equal(c.child.exitCode, null, suffix); await c.end();
  }
  assert.ok(requests().filter(r => !r.method).every(r => !r.error && JSON.stringify(r.result) === '{"answers":{}}'), 'an empty answer set is the native abort; no acceptance reaches the CLI');
});

test('Codex MCP prefix approval rechecks the captured action before sending', async t => {
  const { client, requests } = setup(t); const { c, events } = client();
  await c.ready(); await c.start('MCP_APPROVAL');
  const q = events.find(e => e.type === 'question')?.question; assert(q);
  const previous = events.length;
  c.child.stdin.write(JSON.stringify({ method: 'fixture/mcpItemUpdate' }) + '\n');
  await waitUntil('native item completed', () => events.slice(previous).some(e => e.type === 'activity'));
  await assert.rejects(c.reply({ type: 'reply', id: q.id, value: 'Allow' }), /no longer pending|details changed/);
  assert.equal(requests().filter(r => !r.method).length, 0);
  await c.stop();
});

test('Codex MCP prefix expiry and uncertain delivery never replay an approval', async t => {
  const { client, requests, home } = setup(t);
  for (const task of ['MCP_APPROVAL_AUTO_RESOLVE', 'MCP_APPROVAL_TURN_END']) {
    const { c, events } = client(); await c.ready(); await c.start(task);
    const q = events.find(e => e.type === 'question')?.question; assert(q);
    await settled(events);
    await assert.rejects(c.reply({ type: 'reply', id: q.id, value: 'Allow' }), /pending|answered/);
    await c.end();
  }
  const { c, events } = client(undefined, ['--no-resolved']); await c.ready(); await c.start('MCP_APPROVAL');
  const q = events.find(e => e.type === 'question')?.question; assert(q);
  await assert.rejects(c.reply({ type: 'reply', id: q.id, value: 'Allow' }), /uncertain|timed out/);
  await assert.rejects(c.reply({ type: 'reply', id: q.id, value: 'Allow' }), /pending|answered/);
  assert.equal(requests().filter(r => !r.method && r.result?.answers).length, 1);
  assert.equal(fs.readFileSync(path.join(home, 'mcp-effect.txt'), 'utf8'), '1');
  await c.stop();
});

test('Codex MCP elicitation approves or refuses only one scoped action without persistent metadata', async t => {
  const { client, requests, home } = setup(t);
  for (const [task, answer, action] of [
    ['MCP_ELICIT', { confirmed: true }, 'accept'], ['MCP_ELICIT_STRING_ID', { confirmed: false }, 'decline'],
    ['MCP_ELICIT_LEGACY', { cancelled: true }, 'cancel'], ['MCP_ELICIT_OTHER_DONE', { confirmed: true }, 'accept'],
    ['MCP_ELICIT_OTHER_SERVER', { confirmed: false }, 'decline'],
  ]) {
    const { c, events } = client(); await c.ready(); await c.start(task);
    const q = events.find(e => e.type === 'question')?.question;
    assert(q, 'explicit message-only MCP elicitation must be reviewable');
    assert.equal(q.method, 'confirm'); assert.notEqual(q.kind, 'question'); assert.equal(q.fields, undefined);
    assert.deepEqual(q.parentPolicy, { confirm: true }); assert.match(q.message, /elicitation-only\.txt/);
    const before = requests().filter(r => !r.method).length;
    for (const invalid of [{ value: 'Allow' }, { answers: {} }, { confirmed: 'yes' }, { confirmed: true, cancelled: true }])
      await assert.rejects(c.reply({ type: 'reply', id: q.id, ...invalid }), /MCP|confirm|decision/i);
    assert.equal(requests().filter(r => !r.method).length, before);
    await c.reply({ type: 'reply', id: q.id, ...answer });
    assert.equal((await settled(events)).text, `ELICITATION:${action}`);
    assert.deepEqual(requests().filter(r => !r.method).slice(before).map(({ id, result }) => ({ id, result })),
      [{ id: task.includes('STRING_ID') ? '37' : 37, result: { action, content: null, _meta: null } }]);
    await assert.rejects(c.reply({ type: 'reply', id: q.id, ...answer }), /pending|answered/);
    await c.end();
  }
  assert.equal(fs.readFileSync(path.join(home, 'elicitation-effect.txt'), 'utf8'), '2');
  assert.equal(fs.existsSync(path.join(home, 'elicitation-grants.jsonl')), false);
});

test('Codex MCP elicitation with ambiguous scope, other kinds, data forms or URLs is cancelled natively, never accepted', async t => {
  const { client, requests } = setup(t);
  for (const suffix of ['WRONG_THREAD', 'WRONG_TURN', 'NULL_TURN', 'WRONG_SERVER', 'MISSING_ITEM', 'COMPLETED_ITEM', 'AMBIGUOUS', 'NO_META', 'SUGGESTION', 'DATA_FORM', 'URL']) {
    const { c, events } = client(); await c.ready(); await c.start(`MCP_ELICIT_${suffix}`);
    assert.equal(events.some(e => e.type === 'question'), false, suffix);
    const result = await settled(events); assert.equal(result.status, 'stopped', suffix); assert.equal(result.text, 'ELICITATION:cancel', suffix);
    assert(events.some(e => e.type === 'activity' && e.detail === 'interaction refused: mcpServer/elicitation/request'), suffix);
    assert.equal(c.child.exitCode, null, suffix); await c.end();
  }
  assert.ok(requests().filter(r => !r.method).every(r => !r.error && JSON.stringify(r.result) === '{"action":"cancel","content":null,"_meta":null}'), 'a native cancel reaches the CLI; no acceptance or persistence');
});

test('Codex MCP elicitation rechecks the action and never replays expired or uncertain replies', async t => {
  const { client, requests, home } = setup(t);
  for (const task of ['MCP_ELICIT_AUTO_RESOLVE', 'MCP_ELICIT_TURN_END']) {
    const { c, events } = client(); await c.ready(); await c.start(task);
    const q = events.find(e => e.type === 'question')?.question; assert(q); await settled(events);
    await assert.rejects(c.reply({ type: 'reply', id: q.id, confirmed: true }), /pending|answered/); await c.end();
  }
  const stale = client(); await stale.c.ready(); await stale.c.start('MCP_ELICIT');
  const q = stale.events.find(e => e.type === 'question')?.question; assert(q); const before = stale.events.length;
  stale.c.child.stdin.write(JSON.stringify({ method: 'fixture/mcpItemUpdate' }) + '\n');
  await waitUntil('action completed', () => stale.events.slice(before).some(e => e.type === 'activity'));
  await assert.rejects(stale.c.reply({ type: 'reply', id: q.id, confirmed: true }), /no longer pending|details changed/); await stale.c.stop();
  const uncertain = client(undefined, ['--no-resolved']); await uncertain.c.ready(); await uncertain.c.start('MCP_ELICIT');
  const last = uncertain.events.find(e => e.type === 'question')?.question; assert(last);
  await assert.rejects(uncertain.c.reply({ type: 'reply', id: last.id, confirmed: true }), /uncertain|timed out/);
  await assert.rejects(uncertain.c.reply({ type: 'reply', id: last.id, confirmed: true }), /pending|answered/);
  assert.equal(requests().filter(r => !r.method && r.result?.action === 'accept').length, 1);
  assert.equal(fs.readFileSync(path.join(home, 'elicitation-effect.txt'), 'utf8'), '1'); await uncertain.c.stop();
});

test('Codex task form ends with its turn even without a request-resolved event', async t => {
  const { client, requests } = setup(t); const { c, events } = client();
  await c.ready(); await c.start('QUESTION_NONBLOCKING_TURN_END');
  const q = events.find(e => e.type === 'question')?.question; assert(q);
  assert.equal((await settled(events)).text, 'TURN-ENDED');
  assert.equal(events.filter(e => e.type === 'resolved' && e.id === q.id).length, 1);
  await assert.rejects(c.reply({ type: 'reply', id: q.id, cancelled: true }), /pending|answered/);
  assert.equal(requests().filter(r => !r.method).length, 0); await c.end();
});

test('Codex question auto-resolution and uncertain delivery never allow a replay', async t => {
  const { client, requests } = setup(t);
  const auto = client(); await auto.c.ready(); await auto.c.start('QUESTION_AUTO_RESOLVE');
  const q = auto.events.find(e => e.type === 'question')?.question; assert(q);
  await settled(auto.events);
  await assert.rejects(auto.c.reply({ type: 'reply', id: q.id, cancelled: true }), /pending|answered/);
  await auto.c.end();
  const noAck = client(undefined, ['--no-resolved']); await noAck.c.ready(); await noAck.c.start('QUESTION');
  const pending = noAck.events.find(e => e.type === 'question')?.question; assert(pending);
  await assert.rejects(noAck.c.reply({ type: 'reply', id: pending.id, cancelled: true }), /uncertain|timed out/);
  await assert.rejects(noAck.c.reply({ type: 'reply', id: pending.id, cancelled: true }), /pending|answered/);
  assert.equal(requests().filter(r => !r.method && r.result?.answers).length, 1);
  await noAck.c.stop();
});

test('Codex completed async questions notify immediately and one answer steers the original turn', async t => {
  const { client, requests } = setup(t); const { c, events } = client(undefined, ['--no-final-phase']); const session = await c.ready();
  await c.start('ASYNC_QUESTION_DUPLICATE', 'one');
  const q = events.find(e => e.type === 'question')?.question;
  assert(q, 'a completed async message must notify the parent before any terminal event');
  assert.equal(q.isBlocking, false); assert.equal(q.kind, 'question'); assert.equal(q.method, 'form');
  assert.equal(events.filter(e => e.type === 'question').length, 1);
  assert.equal(events.some(e => e.type === 'settled'), false);
  const turnId = c.activeTurn, answers = { '0': ['custom choice'], '1': ['literal context'] };
  await c.reply({ type: 'reply', id: q.id, answers });
  const text = 'Answers to your questions:\n\nWhich check?\ncustom choice\n\nWhat context is missing?\nliteral context';
  const steers = requests().filter(r => r.method === 'turn/steer'); assert.equal(steers.length, 1);
  assert.deepEqual(steers[0].params, { threadId: session.threadId, expectedTurnId: turnId, input: [{ type: 'text', text }] });
  assert.equal(requests().filter(r => r.method === 'turn/start').length, 1);
  assert.equal(requests().filter(r => !r.method).length, 0, 'async messages have no JSON-RPC request to answer');
  assert.equal((await runSettled(events, 'one')).text, text, 'a late duplicate async item must not replace the actual final answer');
  assert.equal(events.filter(e => e.type === 'question').length, 1);
  assert.equal(events.filter(e => e.type === 'resolved' && e.id === q.id).length, 1);
  await assert.rejects(c.reply({ type: 'reply', id: q.id, answers }), /pending|answered/);
});

test('Codex async dismissal is local and expired or foreign messages cannot acquire a new turn', async t => {
  const { client, requests } = setup(t); const { c, events } = client(); const session = await c.ready();
  await c.start('ASYNC_QUESTION', 'cancel');
  const q = events.find(e => e.type === 'question')?.question; assert(q);
  await c.reply({ type: 'reply', id: q.id, cancelled: true });
  assert.equal(requests().filter(r => r.method === 'turn/steer').length, 0);
  await c.send('DONE', 'steer'); await runSettled(events, 'cancel');
  await c.start('ASYNC_QUESTION_TURN_END', 'expired');
  const late = events.filter(e => e.type === 'question').at(-1).question; await runSettled(events, 'expired');
  const oldTurn = requests().filter(r => r.method === 'turn/steer').at(-1).params.expectedTurnId;
  await c.start('HOLD', 'next');
  await assert.rejects(c.reply({ type: 'reply', id: late.id, cancelled: true }), /pending|answered/);
  const base = { type: 'agentMessage', text: 'Do not expose this as a task form', phase: 'final_answer', delivery: 'async', questions: [{ title: 'Context?', options: null }] };
  const records = [
    { method: 'item/completed', params: { threadId: 'foreign', turnId: c.activeTurn, item: { ...base, id: 'foreign' } } },
    { method: 'item/completed', params: { threadId: session.threadId, turnId: oldTurn, item: { ...base, id: 'expired' } } },
    { method: 'item/completed', params: { threadId: session.threadId, turnId: c.activeTurn, item: { ...base, id: 'malformed', questions: [{ title: 'Context?', options: {} }] } } },
  ];
  c.child.stdin.write(JSON.stringify({ method: 'fixture/emit', params: { records } }) + '\n');
  await c.send('NEXT-DONE', 'steer'); await runSettled(events, 'next');
  assert.equal(events.filter(e => e.type === 'question').length, 2);
  assert.equal(requests().filter(r => !r.method).length, 0);
});

test('Codex uncertain async steering is never retried or converted into a new turn', async t => {
  const { client, requests } = setup(t); const { c, events } = client(undefined, ['--no-steer-response']);
  await c.ready(); await c.start('ASYNC_QUESTION', 'one');
  const q = events.find(e => e.type === 'question')?.question; assert(q);
  const answers = { '0': ['Unit'], '1': ['task context'] };
  await assert.rejects(c.reply({ type: 'reply', id: q.id, answers }), /timed out|uncertain/);
  await assert.rejects(c.reply({ type: 'reply', id: q.id, answers }), /pending|answered/);
  assert.equal(requests().filter(r => r.method === 'turn/steer').length, 1);
  assert.equal(requests().filter(r => r.method === 'turn/start').length, 1);
});

for (const fault of ['write', 'deadline']) test(`Codex observes approval rejection before the ${fault} completes`, () => {
  const source = `
    import assert from 'node:assert/strict';
    import { CodexAdapter } from ${JSON.stringify(new URL('../dist/codex-adapter.js', import.meta.url).href)};
    const c = Object.create(CodexAdapter.prototype), fault = ${JSON.stringify(fault)};
    Object.assign(c, { approvals: new Map(), approvalByRpcId: new Map(), activeTurn: 'turn',
      thread: { threadId: 'thread' }, timeout: 10, options: { onEvent() {} } });
    const approval = { id: 'question', rpcId: 17, threadId: 'thread', turnId: 'turn', attempted: false };
    c.approvals.set(approval.id, approval);
    c.approvalByRpcId.set('number:17', approval);
    let writes = 0;
    c.write = async () => {
      writes++;
      if (fault === 'write') {
        c.clearApproval(approval, new Error('fixture stream closed during write'));
        throw new Error('fixture write failed');
      }
      await new Promise(resolve => setTimeout(resolve, 40));
    };
    await assert.rejects(c.reply({ id: approval.id, confirmed: false }),
      fault === 'write' ? /fixture write failed/ : /resolution timed out/);
    await assert.rejects(c.reply({ id: approval.id, confirmed: true }), /pending|answered/);
    assert.equal(writes, 1, 'uncertain delivery must not be replayed');
    await new Promise(resolve => setImmediate(resolve));
    console.log('APPROVAL_FAILURE_OBSERVED');
  `;
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', source],
    { env, encoding: 'utf8', timeout: 10_000, windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /APPROVAL_FAILURE_OBSERVED/, 'the inner process must actually execute the assertions');
});

test('Codex server request callback failure poisons its run and requests release', async t => {
  const { client } = setup(t), { c, events } = client(); await c.ready();
  const record = c.options.onEvent;
  c.options.onEvent = event => {
    if (event.type === 'question') throw new Error('fixture question persistence failed');
    record(event);
  };
  await c.start('APPROVAL', 'failed-question');
  const result = await runSettled(events, 'failed-question');
  assert.equal(result.status, 'failed'); assert.equal(result.stop, true);
  assert.match(result.error, /fixture question persistence failed/);
  assert.equal(c.approvals.size, 0);
  await assert.rejects(c.start('REPLAY', 'next'), /fixture question persistence failed/);
  await assert.rejects(c.send('REPLAY', 'steer'), /fixture question persistence failed/);
  await c.stop();
  assert.notEqual(c.child.exitCode ?? c.child.signalCode, null, 'the fixture CLI is reaped before release');
});

test('Codex still closes after both question and failure-event persistence throw', async t => {
  const { client } = setup(t), { c } = client(); await c.ready();
  let failed = false;
  c.options.onEvent = event => {
    if (event.type === 'question') failed = true;
    if (failed) throw new Error('fixture persistent event failure');
  };
  await c.start('APPROVAL', 'failed-sink');
  await waitUntil('fixture CLI closed after event failure', () => c.child.exitCode !== null || c.child.signalCode !== null, 10_000);
  await c.closed;
  assert.equal(c.approvals.size, 0);
  await assert.rejects(c.reply({ id: 'expired', confirmed: true }), /no longer pending/);
  await assert.rejects(c.start('REPLAY', 'next'), /fixture persistent event failure/);
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

test('Codex activity names the step instead of the raw item method', async t => {
  const { client } = setup(t); const { c, events } = client(); await c.ready();
  await c.start('TRANSCRIPT', 'one'); await runSettled(events, 'one');
  await c.start('COMMENTARY', 'two'); await runSettled(events, 'two');
  const labels = events.filter(e => e.type === 'activity').map(e => e.detail);
  assert(!labels.some(label => label.includes('/')), `raw native method leaked: ${JSON.stringify(labels)}`);
  for (const expected of ['Turn started', 'Thinking', 'Reading the task', 'Running a command', 'Writing a reply'])
    assert(labels.includes(expected), `${expected} missing from ${JSON.stringify(labels)}`);
  await c.end();
});
