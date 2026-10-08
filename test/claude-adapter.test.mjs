import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter, inspectClaudeSession } from '../dist/claude-adapter.js';
import { waitUntil } from '../dist/storage.js';
import { tempDir } from './helpers/tmp.mjs';
const fixture = fileURLToPath(new URL('./fixtures/claude.mjs', import.meta.url));
function setup(t) {
  const cwd = tempDir('claude-adapter');
  const home = path.join(cwd, 'home'); fs.mkdirSync(home); fs.writeFileSync(path.join(home, 'fixture-home'), '');
  const spec = { version: 3, cli: 'claude', id: 'fixture', cwd, claudeHome: home, roleName: 'worker',
    role: { cli: 'claude', description: 'test', instructions: 'Do only assigned work.' }, launch: { command: process.execPath, args: [fixture] } };
  const clients = [];
  t.after(async () => { for (const c of clients) await c.stop(); });
  const client = (session, flags = [], requestTimeout = 1000) => {
    const events = [];
    const c = new ClaudeAdapter({ spec: { ...spec, launch: { ...spec.launch, args: [...spec.launch.args, ...flags] } }, session,
      logFile: path.join(cwd, `${clients.length}.jsonl`), onEvent: e => events.push(e), requestTimeout });
    clients.push(c); return { c, events };
  };
  const requests = () => fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return { client, requests, spec, home, cwd };
}
const terminal = events => waitUntil('Claude terminal', () => events.find(e => e.type === 'settled'), 3000);
const question = events => waitUntil('Claude permission', () => events.find(e => e.type === 'question')?.question, 3000);

test('Claude terminal result does not require optional session-state events', async t => {
  const {client} = setup(t);
  for (const flags of [[], ['--state-events']]) {
    const {c,events} = client(undefined,flags); await c.ready(); await c.start('DONE');
    const result = await terminal(events); assert.equal(result.status,'completed'); assert.equal(result.text,'OK');
    const closed = await c.end(); assert.equal(closed.exit.code,0); assert.equal(closed.forced,false);
  }
});

test('Claude nonempty result queue still blocks completion without session-state events', async t => {
  const {client} = setup(t); const {c,events} = client(); await c.ready(); await c.start('QUEUE_NONEMPTY');
  await waitUntil('queued result observed',()=>c.result,1000); assert(!events.some(e=>e.type==='settled'));
  await c.end();
});

test('Claude handshake submits no prompt; resume keeps the native ID, home and history', async t => {
  const {client, requests, home, spec} = setup(t); const first = client(); const session = await first.c.ready();
  assert.equal(session.cli, 'claude'); assert.equal(session.claudeHome, home); assert.equal(session.sessionFile, undefined);
  assert(!requests().some(r => r.type === 'user'));
  await first.c.start('REMEMBER marker'); assert.equal((await terminal(first.events)).status, 'completed');
  assert.equal((await first.c.end()).exit.code, 0);
  const file = inspectClaudeSession(spec, session), bytes = fs.readFileSync(file);
  assert.equal(inspectClaudeSession(spec, session), file); assert.deepEqual(fs.readFileSync(file), bytes);
  const next = client(session); assert.deepEqual(await next.c.ready(), session);
  await next.c.start('RECALL'); assert.equal((await terminal(next.events)).text, 'marker'); await next.c.end();
  const launches = fs.readFileSync(path.join(home, 'launches.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert(launches[0].args.includes('--session-id')); assert(launches[1].args.includes('--resume'));
  assert(!launches.some(l => l.args.some(a => ['--continue', '--fork-session', '--dangerously-skip-permissions', '--no-session-persistence'].includes(a))));
});

test('Claude fails missing/ambiguous/foreign native metadata before launching a resume', async t => {
  const {client, spec, home} = setup(t); const first = client(); const session = await first.c.ready();
  await first.c.start('REMEMBER x'); await terminal(first.events); await first.c.end();
  const file = inspectClaudeSession(spec, session), bytes = fs.readFileSync(file);
  assert.throws(() => inspectClaudeSession({...spec, cwd: path.dirname(spec.cwd)}, session), /directory|cwd/i);
  assert.throws(() => client({...session, claudeHome: path.dirname(home)}), /home|store/i);
  fs.mkdirSync(path.join(home, 'projects', 'duplicate')); const dupe = path.join(home, 'projects', 'duplicate', path.basename(file)); fs.writeFileSync(dupe, bytes);
  assert.throws(() => client(session), /ambiguous/i); fs.unlinkSync(dupe);
  fs.writeFileSync(file, bytes.toString().replaceAll(session.sessionId, 'foreign'));
  assert.throws(() => client(session), /identity|session/i);
  fs.unlinkSync(file); assert.throws(() => client(session), /missing/i);
});

test('Claude startup identity notification is optional on new and resumed sessions', async t => {
  const {client,requests} = setup(t);
  const first = client(undefined,['--no-identity']); const session = await first.c.ready();
  assert(!requests().some(r=>r.type==='user'));
  await first.c.start('REMEMBER native-context'); await terminal(first.events); await first.c.end();
  const resumed = client(session,['--no-identity']); assert.deepEqual(await resumed.c.ready(),session);
  await resumed.c.start('RECALL'); assert.equal((await terminal(resumed.events)).text,'native-context'); await resumed.c.end();
});

test('Claude still rejects missing readiness and a different first init identity or cwd', async t => {
  const {client} = setup(t); const early = client(undefined,['--no-identity']);
  await assert.rejects(early.c.start('NOT READY'),/not ready/); await early.c.end();
  for (const flag of ['--wrong-init','--wrong-init-cwd']) {
    const {c,events} = client(undefined,['--no-identity',flag]); await c.ready();
    await assert.rejects(c.start('MUST NOT ACCEPT'),/different.*session|different.*directory/i);
    assert(!events.some(e=>e.type==='settled'&&e.status==='completed')); await c.stop();
  }
});

test('Claude does not submit tasks after an explicitly wrong startup identity or cwd', async t => {
  const {client, requests} = setup(t);
  for (const flag of ['--wrong-identity', '--wrong-cwd']) {
    const {c} = client(undefined, [flag]); await assert.rejects(c.ready(), /identity|session|directory|timed out/i); await c.stop();
  }
  assert(!requests().some(r => r.type === 'user'));
});

test('Claude ignores foreign result UUIDs, waits for background tasks and never equates API error with success', async t => {
  const {client} = setup(t);
  for (const task of ['FOREIGN_RESULT', 'BACKGROUND', 'FAIL']) {
    const {c, events} = client(); await c.ready(); await c.start(task);
    if (task === 'BACKGROUND') {
      await waitUntil('root result before background release', () => c.result, 1000);
      assert(!events.some(e => e.type === 'settled'), 'a root result is insufficient while background work remains');
      c.child.stdin.write(JSON.stringify({type:'fixture/release-background'})+'\n');
    }
    const result = await terminal(events);
    assert.equal(result.status, task === 'FAIL' ? 'failed' : 'completed');
    assert.equal(result.text, task === 'FOREIGN_RESULT' ? 'CURRENT' : task === 'BACKGROUND' ? 'ROOT' : 'model failed');
    assert.equal(events.filter(e => e.type === 'settled').length, 1); await c.end();
  }
});

test('Claude stop cancels the native turn/queue, preserves session, and unsupported active steering writes nothing', async t => {
  const {client, requests, spec} = setup(t); const {c, events} = client(); const session = await c.ready(); await c.start('HOLD');
  const before = requests().length; await assert.rejects(c.send('STEER', 'steer'), /steer.*not supported/i);
  await assert.rejects(c.send('FOLLOW', 'followUp'), /followUp.*not supported/i); assert.equal(requests().length, before);
  const end = await c.stop(); assert.equal(end.exit.code, 0); assert.equal(end.forced, false);
  assert.equal((await terminal(events)).status, 'stopped'); assert(fs.existsSync(inspectClaudeSession(spec, session)));
  assert.equal(requests().find(r => r.request?.subtype === 'interrupt').request.cancel_queued, true);
});

test('Claude bounds stop even when the native interrupt never acknowledges', {timeout:15000}, async t => {
  const {client,spec} = setup(t); const {c} = client(undefined,['--ignore-interrupt'],10000);
  const session = await c.ready(); await c.start('HOLD'); const start = Date.now();
  const stopped = await c.stop(); assert.equal(stopped.forced,true);
  assert(Date.now()-start < 7000, 'stop must not consume two full control-request deadlines');
  assert(fs.existsSync(inspectClaudeSession(spec,session)));
});

test('Claude approvals preserve exact input and never write persistent permissions', async t => {
  const {client, requests} = setup(t);
  for (const [answer, expected] of [[{value:'Approve once'}, 'ALLOW'], [{value:'Deny once'}, 'DENY'], [{cancelled:true}, 'DENY']]) {
    const {c, events} = client(); await c.ready(); await c.start('APPROVAL'); const q = await question(events);
    assert.deepEqual(q.options, ['Deny once', 'Approve once', 'Cancel turn']); assert.match(q.message, /work.txt/);
    await assert.rejects(c.reply({type:'reply', id:q.id, confirmed:true}), /explicit|choices/i);
    await c.reply({type:'reply', id:q.id, ...answer}); assert.equal((await terminal(events)).text, expected);
    await assert.rejects(c.reply({type:'reply', id:q.id, ...answer}), /pending|answered/i); await c.end();
  }
  const replies = requests().filter(r => r.type === 'control_response');
  assert.equal(replies.length, 3);
  assert.deepEqual(replies[0].response.response.updatedInput, {file_path:'work.txt',content:'fixture'});
  assert(replies.every(r => !('updatedPermissions' in r.response.response)));
});

test('Claude manual approval cannot be supplied by parent; unsafe, duplicate and expired requests fail closed', async t => {
  const {client, requests} = setup(t); const manual = client(); await manual.c.ready(); await manual.c.start('APPROVAL_MANUAL');
  const q = await question(manual.events); assert.equal(q.humanOnly, true);
  await assert.rejects(manual.c.reply({type:'reply', id:q.id, value:'Approve once', actor:'parent'}), /human/i);
  await manual.c.reply({type:'reply', id:q.id, value:'Deny once', actor:'parent'}); await terminal(manual.events); await manual.c.end();
  for (const task of ['APPROVAL_DIALOG', 'APPROVAL_UNSCOPED', 'APPROVAL_NO_NAME', 'APPROVAL_DUPLICATE', 'APPROVAL_EXPIRED']) {
    const {c, events} = client(); await c.ready(); await c.start(task);
    const result = await terminal(events); assert.equal(result.status, task === 'APPROVAL_EXPIRED' ? 'completed' : 'failed');
    for (const e of events.filter(e=>e.type==='question')) await assert.rejects(c.reply({type:'reply', id:e.question.id, value:'Approve once'}), /pending|answered/i);
    await c.stop();
  }
  assert(!requests().some(r=>r.response?.response?.behavior==='allow'));
});

test('Claude early unscoped approval, malformed stdout and process death are not completions', async t => {
  const {client} = setup(t);
  const early = client(undefined, ['--early-approval']); await assert.rejects(early.c.ready(), /interaction|scope|failed/i); await early.c.stop();
  for (const task of ['NOISE', 'CRASH']) {
    const {c, events} = client(); await c.ready(); await assert.rejects(c.start(task), /JSON|exited|record/i);
    assert(!events.some(e=>e.type==='settled' && e.status==='completed')); await c.stop();
  }
});
