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
    const logFile = path.join(cwd, `${clients.length}.jsonl`);
    const c = new ClaudeAdapter({ spec: { ...spec, launch: { ...spec.launch, args: [...spec.launch.args, ...flags] } }, session,
      logFile, onEvent: e => events.push(e), requestTimeout });
    clients.push(c); return { c, events, logFile };
  };
  const requests = () => fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return { client, requests, spec, home, cwd };
}
const terminal = events => waitUntil('Claude terminal', () => events.find(e => e.type === 'settled'), 3000);
const question = events => waitUntil('Claude permission', () => events.find(e => e.type === 'question')?.question, 3000);
const taskQuestion = async events => {
  const first = await waitUntil('Claude task question or failure', () => events.find(e => e.type === 'question' || e.type === 'settled'), 3000);
  assert.equal(first.type, 'question', first.error); return first.question;
};
const skipped = q => Object.fromEntries(q.fields.map(field => [field.id, []]));

test('Claude stays resident across completed, interrupted and subsequent runs without another init', async t => {
  const { client, requests } = setup(t); const { c, events } = client(undefined,['--init-once','--result-before-receipt']);
  await c.ready(); assert.equal(c.resident,true); const pid=c.pid;
  await c.start('REMEMBER marker','one'); assert.equal((await terminal(events)).text,'OK');
  await c.start('HOLD','two'); await c.send('MUST_NOT_RUN','followUp'); await c.interrupt();
  const stopped=events.find(e=>e.type==='settled'&&e.runId==='two');assert.equal(stopped.status,'stopped');
  assert.equal(c.child.exitCode,null);assert.equal(c.pid,pid);
  await c.start('RECALL','three'); const last=await waitUntil('third Claude result',()=>events.find(e=>e.type==='settled'&&e.runId==='three'));
  assert.equal(last.text,'marker');assert.equal(events.filter(e=>e.type==='settled').length,3);
  assert.equal(requests().filter(r=>r.request?.subtype==='interrupt').length,1);
  assert.equal(requests().find(r=>r.request?.subtype==='interrupt').request.cancel_queued,true);
  assert.equal((await c.end()).exit.code,0);
});

test('Claude steer is non-preempting next input and followUp stays in the same run through queue drain', async t => {
  const {client,requests}=setup(t),{c,events}=client();await c.ready();await c.start('HOLD','steer');
  await c.send('correction','steer');assert.equal((await terminal(events)).text,'STEER:correction');
  await c.start('HOLD','follow');await c.send('FOLLOW','followUp');
  assert(!events.some(e=>e.type==='settled'&&e.runId==='follow'));
  c.child.stdin.write(JSON.stringify({type:'fixture/release-turn'})+'\n');
  const last=await waitUntil('followUp final result',()=>events.find(e=>e.type==='settled'&&e.runId==='follow'));
  assert.equal(last.text,'FOLLOW');assert.equal(events.filter(e=>e.type==='settled'&&e.runId==='follow').length,1);
  const input=requests().filter(r=>r.type==='user');assert.equal(input[1].priority,'next');assert.equal(input[3].priority,'later');
  assert(!requests().some(r=>r.request?.subtype==='interrupt'));await c.end();
});

test('Claude queued input can ask permission after an earlier native result without approving stale tools', async t => {
  const {client}=setup(t),{c,events}=client();await c.ready();await c.start('HOLD','queued-approval');
  await c.send('APPROVAL','followUp');c.child.stdin.write(JSON.stringify({type:'fixture/release-turn'})+'\n');
  const q=await taskQuestion(events);assert(c.result,'the earlier foreground result is still available');
  await c.reply({type:'reply',id:q.id,value:'Approve once',actor:'parent'});
  assert.equal((await terminal(events)).text,'ALLOW');await c.end();
});

test('Claude resets result, background and approval state, and ignores old result UUIDs in a later run', async t => {
  const {client}=setup(t),{c,events}=client();await c.ready();await c.start('BACKGROUND','background');
  await waitUntil('background root result',()=>c.result);const old=c.result;
  await assert.rejects(c.start('TOO_EARLY','new'),/not ready|active/i);
  c.record({...old,result:'STALE_DUPLICATE'});
  c.child.stdin.write(JSON.stringify({type:'fixture/release-background'})+'\n');assert.equal((await terminal(events)).text,'ROOT');
  await c.start('QUESTION','question');const q=await waitUntil('next-run form',()=>events.find(e=>e.type==='question'&&e.runId==='question')?.question);
  await c.reply({type:'reply',id:q.id,answers:skipped(q),actor:'parent'});
  await waitUntil('question run done',()=>events.find(e=>e.type==='settled'&&e.runId==='question'));
  await c.start('HOLD','last');c.record(old);
  assert(!events.some(e=>e.type==='settled'&&e.runId==='last'));
  await assert.rejects(c.reply({type:'reply',id:q.id,cancelled:true}),/pending|answered/);
  await c.interrupt();assert.equal(events.find(e=>e.type==='settled'&&e.runId==='last').status,'stopped');await c.end();
});

test('Claude rejects missing native receipts before delivery and poisons uncertain input or interrupt outcomes', async t => {
  const {client,requests}=setup(t);
  for(const [flag,operation,error] of [
    ['--no-lifecycle-cap','send',/capability|receipt|lifecycle/i],
    ['--no-cancel-cap','interrupt',/capability|queued|receipt/i],
    ['--no-send-ack','send',/uncertain|timed out/i],
    ['--interrupt-survivor','interrupt',/uncertain|queued|surviv/i],
    ['--interrupt-no-terminal','interrupt',/uncertain|timed out/i],
  ]) {
    const {c}=client(undefined,[flag]);await c.ready();await c.start('HOLD');c.timeout=100;
    const before=requests().filter(r=>r.type==='user').length;
    await assert.rejects(operation==='send'?c.send('FOLLOW','followUp'):c.interrupt(),error);
    if(flag.startsWith('--no-')&&flag!=='--no-send-ack')assert.equal(requests().filter(r=>r.type==='user').length,before);
    else await assert.rejects(c.send('DO_NOT_REPLAY','steer'),/uncertain|timed out|queued|surviv/i);
    await c.stop();
  }
});

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
  assert.equal(fs.readFileSync(path.join(home, 'launches.jsonl'), 'utf8').trim().split('\n').length, 1,
    'rejected identity must not launch a resume or a replacement');
});

test('Claude preflight keeps the initial mainline cwd while later tool directories change', () => {
  const cwd = tempDir('claude-cwd'), home = path.join(cwd, 'home'), sessionId = '11111111-1111-4111-8111-111111111111';
  const file = path.join(home, 'projects', 'fixture-project', `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const spec = { cwd, claudeHome: home }, session = { cli: 'claude', sessionId, claudeHome: home };
  for (const changed of [path.join(cwd, 'apps', 'cli'), path.join(path.dirname(cwd), 'other-project')]) {
    const rows = [
      { type: 'user', sessionId, cwd: changed, isSidechain: true },
      { type: 'user', sessionId, cwd, parentUuid: null, isSidechain: false },
      { type: 'attachment', sessionId, cwd: changed, isSidechain: false },
      { type: 'assistant', sessionId, cwd: changed, isSidechain: false },
      { type: 'progress', data: 'x'.repeat(70_000) },
      { type: 'user', sessionId, cwd: changed, isSidechain: false },
    ];
    const bytes = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    fs.writeFileSync(file, bytes);
    assert.equal(inspectClaudeSession(spec, session), file);
    assert.deepEqual(fs.readFileSync(file), bytes, 'preflight must not rewrite the original history');
    assert.throws(() => inspectClaudeSession({ ...spec, cwd: changed }, session), /directory|cwd/i,
      'a later matching cwd must not replace the original mainline cwd');
  }
});

test('Claude preflight does not use later cwd matches or a sampled tail as startup identity', () => {
  const cwd = tempDir('claude-cwd-guards'), home = path.join(cwd, 'home'), sessionId = '11111111-1111-4111-8111-111111111111';
  const file = path.join(home, 'projects', 'fixture-project', `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const spec = { cwd, claudeHome: home }, session = { cli: 'claude', sessionId, claudeHome: home };
  const original = { type: 'user', sessionId, cwd, isSidechain: false };
  for (const [rows, error] of [
    [[{ ...original, cwd: path.dirname(cwd) }, original], /directory|cwd/i],
    [[{ ...original, cwd: undefined }, original], /identity|metadata|cwd/i],
    [[{ ...original, sessionId: undefined }, original], /identity|metadata/i],
    [[{ ...original, message: 'x'.repeat(70_000) }, original], /identity|metadata/i],
    [[original, { type: 'progress', data: 'x'.repeat(70_000) }, { ...original, sessionId: 'foreign' }], /identity|session/i],
    [[original, { type: 'attachment', sessionId, cwd: 42 }], /metadata|cwd|directory/i],
  ]) {
    fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    assert.throws(() => inspectClaudeSession(spec, session), error);
  }
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

test('Claude stop cancels the native turn/queue and preserves the session', async t => {
  const {client, requests, spec} = setup(t); const {c, events} = client(); const session = await c.ready(); await c.start('HOLD');
  await c.send('FOLLOW', 'followUp');
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

test('Claude native policy signals stay visible but do not block the parent; unsupported, duplicate and expired requests are refused per request', async t => {
  const {client, requests} = setup(t); const manual = client(); await manual.c.ready(); await manual.c.start('APPROVAL_MANUAL');
  const q = await question(manual.events); assert.notEqual(q.humanOnly, true);
  assert.match(q.message, /^Native policy signals: classifier not approvable\./); assert.deepEqual(q.parentPolicy, { values: ['Deny once', 'Approve once', 'Cancel turn'] });
  await manual.c.reply({type:'reply', id:q.id, value:'Approve once', actor:'parent'}); assert.equal((await terminal(manual.events)).text, 'ALLOW'); await manual.c.end();
  for (const task of ['APPROVAL_DIALOG', 'APPROVAL_UNSCOPED', 'APPROVAL_NO_NAME']) {
    const {c, events} = client(); await c.ready(); await c.start(task);
    const result = await terminal(events); assert.equal(result.status, 'completed', task); assert.equal(result.text, 'DENY', task);
    assert.equal(events.some(e=>e.type==='question'), false, task);
    assert(events.some(e=>e.type==='activity'&&/^interaction refused: can_use_tool$/.test(e.detail)), task);
    assert.equal(c.child.exitCode, null, 'a refused interaction must not kill the runtime'); await c.end();
  }
  { const {c, events} = client(); await c.ready(); await c.start('APPROVAL_DUPLICATE'); const dup = await question(events);
    assert.equal(events.filter(e=>e.type==='question').length, 1, 'a duplicate request id must not open a second question');
    const before = requests().filter(r=>r.type==='control_response').length;
    await c.reply({type:'reply', id:dup.id, value:'Deny once', actor:'parent'}); assert.equal((await terminal(events)).text, 'DENY');
    assert.equal(requests().filter(r=>r.type==='control_response').length - before, 1, 'the duplicate request id receives no second response');
    assert(events.some(e=>e.type==='activity'&&/duplicate request id ignored/.test(e.detail))); await c.end(); }
  { const {c, events} = client(); await c.ready(); await c.start('APPROVAL_EXPIRED');
    assert.equal((await terminal(events)).status, 'completed');
    for (const e of events.filter(e=>e.type==='question')) await assert.rejects(c.reply({type:'reply', id:e.question.id, value:'Approve once'}), /pending|answered/i);
    await c.stop(); }
  assert.equal(requests().filter(r=>r.response?.response?.behavior==='allow').length, 1, 'only the parent-approved manual request was allowed');
  const refusals = requests().filter(r=>r.response?.response?.behavior==='deny'&&/not approved by the delegated-task controller/.test(r.response.response.message));
  assert.equal(refusals.length, 3); assert(refusals.every(r=>r.response.response.interrupt===false&&typeof r.response.response.toolUseID==='string'));
});

test('Claude AskUserQuestion returns one correlated structured answer, never a blanket approval', async t => {
  const {client,requests} = setup(t), {c,events,logFile} = client();
  await c.ready(); await c.start('QUESTION'); const q = await taskQuestion(events);
  assert.equal(q.kind,'question'); assert.equal(q.method,'form'); assert.deepEqual(q.parentPolicy,{answers:true});
  assert.notEqual(q.humanOnly,true); assert.equal(q.options,undefined); assert.equal(q.title,'Fixture task questions');
  assert.deepEqual(q.fields.map(f=>f.id),['Which checks?','Which outputs?','What marker?','How many items?']);
  assert.deepEqual(q.fields.map(f=>f.multiSelect),[false,true,false,false]); assert(q.fields.every(f=>f.allowOther));
  assert.equal(q.fields[0].options[0].preview,'<pre>work.txt</pre>'); assert.match(q.fields[3].description,/min.*1.*max.*10/);
  const answers = {'Which checks?':['Read, write'],'Which outputs?':['Logs','Summary'],'What marker?':[' literal\nmarker '],'How many items?':[]};
  for(const invalid of [{value:'Approve once'},{confirmed:true},{answers:{}},{answers:{...answers,'Which checks?':['Read, write','Review']}},{answers,cancelled:true}])
    await assert.rejects(c.reply({type:'reply',id:q.id,actor:'parent',...invalid}),/answers|form|field|single|one|cancellation/i);
  await c.reply({type:'reply',id:q.id,answers,actor:'parent'});
  const result = await terminal(events); assert.equal(result.status,'completed');
  const expected = {'Which checks?':'Read, write','Which outputs?':['Logs','Summary'],'What marker?':' literal\nmarker ','How many items?':''};
  assert.deepEqual(JSON.parse(result.text),expected);
  await assert.rejects(c.reply({type:'reply',id:q.id,answers,actor:'parent'}),/pending|answered/); await c.end();
  const native = fs.readFileSync(logFile,'utf8').trim().split('\n').map(JSON.parse);
  const ask = native.find(r=>r.type==='control_request'); assert.equal(ask.request.requires_user_interaction,true);
  const replies = requests().filter(r=>r.type==='control_response'); assert.equal(replies.length,1);
  assert.equal(replies[0].response.request_id,ask.request_id);
  assert.deepEqual(replies[0].response.response,{behavior:'allow',toolUseID:ask.request.tool_use_id,updatedInput:{...ask.request.input,answers:expected}});
  const output = native.find(r=>r.type==='user'&&r.message?.content?.[0]?.type==='tool_result').message.content[0];
  assert.equal(output.tool_use_id,ask.request.tool_use_id); assert.deepEqual(JSON.parse(output.content),expected);
  assert.equal(requests().filter(r=>r.type==='user').length,1,'an answer is not a new task');
  assert.equal(events.filter(e=>e.type==='resolved'&&e.id===q.id).length,1);
});

test('Claude task forms surface native policy signals as context, stay parent-answerable, and cancellation denies only the question', async t => {
  const {client,requests} = setup(t);
  const signals = {QUESTION_MANUAL:'classifier not approvable',QUESTION_RULE:'matched ask rule',QUESTION_REASON_RULE:'decision reason: rule'};
  for(const task of Object.keys(signals)) {
    const {c,events} = client(); await c.ready(); await c.start(task); const q = await taskQuestion(events);
    assert.notEqual(q.humanOnly,true); assert.deepEqual(q.parentPolicy,{answers:true});
    assert.match(q.message,new RegExp('^Native policy signals: '+signals[task]+'\\.'));
    if(task==='QUESTION_MANUAL') await c.reply({type:'reply',id:q.id,answers:skipped(q),actor:'parent'});
    else await c.reply({type:'reply',id:q.id,cancelled:true,actor:'parent'});
    const result = await terminal(events); assert.equal(result.status,'completed');
    if(task!=='QUESTION_MANUAL') assert.equal(result.text,'QUESTION_CANCELLED'); await c.end();
  }
  const replies = requests().filter(r=>r.type==='control_response').map(r=>r.response.response);
  assert.equal(replies.length,3); assert.equal(replies.filter(r=>r.behavior==='allow').length,1);
  for(const task of ['QUESTION_HOOK','QUESTION_MODE']) {
    const {c,events}=client();await c.ready();await c.start(task);const q=await taskQuestion(events);
    assert.notEqual(q.humanOnly,true); assert.doesNotMatch(q.message,/Native policy signals/,'a reason category alone is not a native policy signal');
    await c.reply({type:'reply',id:q.id,answers:skipped(q),actor:'parent'});
    assert.equal((await terminal(events)).status,'completed');await c.end();
  }
  assert(replies.filter(r=>r.behavior==='deny').every(r=>r.interrupt===false&&r.updatedInput===undefined&&r.updatedPermissions===undefined));
});

test('Claude malformed or host-owned forms are denied per request without approval, and closed requests cannot be replayed', async t => {
  const {client,requests} = setup(t);
  for(const task of ['QUESTION_HOST_FIELDS','QUESTION_INVALID','QUESTION_MCP','QUESTION_BROWSER','QUESTION_OVERSIZED']) {
    const {c,events} = client(); await c.ready(); await c.start(task);
    const result = await terminal(events); assert.equal(result.status,'completed',task); assert.equal(result.text,'QUESTION_CANCELLED',task);
    assert.equal(events.some(e=>e.type==='question'),false,task); assert(events.some(e=>e.type==='activity'&&/^interaction refused: can_use_tool$/.test(e.detail)),task);
    assert.equal(c.child.exitCode,null,task); await c.end();
  }
  { const {c,events} = client(); await c.ready(); await c.start('QUESTION_DUPLICATE'); const q = await taskQuestion(events);
    assert.equal(events.filter(e=>e.type==='question').length,1,'a duplicate request id must not open a second question');
    const before = requests().filter(r=>r.type==='control_response').length;
    await c.reply({type:'reply',id:q.id,answers:skipped(q),actor:'parent'}); assert.equal((await terminal(events)).status,'completed');
    assert.equal(requests().filter(r=>r.type==='control_response').length-before,1,'the duplicate request id receives no second response');
    assert(events.some(e=>e.type==='activity'&&/duplicate request id ignored/.test(e.detail))); await c.end(); }
  { const {c,events} = client(); await c.ready(); await c.start('QUESTION_EXPIRED');
    assert.equal((await terminal(events)).status,'completed');
    for(const e of events.filter(e=>e.type==='question')) await assert.rejects(c.reply({type:'reply',id:e.question.id,answers:skipped(e.question),actor:'parent'}),/pending|answered/);
    await c.stop(); }
  const denials = requests().filter(r=>r.response?.response?.behavior==='deny');
  assert.equal(denials.length,5); assert(denials.every(r=>r.response.subtype==='success'&&r.response.response.interrupt===false&&typeof r.response.response.toolUseID==='string'));
  assert.equal(requests().filter(r=>r.response?.response?.behavior==='allow').length,1,'only the duplicate case was answered, once');
});

test('Claude simultaneous task forms keep native request IDs separate when answered in reverse order', async t => {
  const {client,requests} = setup(t), {c,events,logFile} = client(); await c.ready(); await c.start('QUESTION_PAIR');
  await taskQuestion(events); const forms = await waitUntil('two forms',()=>{const found=events.filter(e=>e.type==='question');return found.length===2?found.map(e=>e.question):undefined;},3000);
  for(const q of [...forms].reverse()) await c.reply({type:'reply',id:q.id,actor:'parent',answers:{...skipped(q),'What marker?':[q.title]}});
  const result = await terminal(events); assert.equal(result.status,'completed');
  assert.deepEqual(JSON.parse(result.text).map(answer=>answer['What marker?']),['Second form','Fixture task questions']); await c.end();
  const asks=fs.readFileSync(logFile,'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.type==='control_request');
  const replies=requests().filter(r=>r.type==='control_response'); assert.equal(replies.length,2);
  for(const reply of replies) {
    const ask=asks.find(r=>r.request_id===reply.response.request_id); assert(ask);
    assert.equal(reply.response.response.toolUseID,ask.request.tool_use_id);
    assert.equal(reply.response.response.updatedInput.answers['What marker?'],ask.request.input.title);
  }
});

test('Claude uncertain question writes are attempted once and never automatically replayed', async t => {
  const {client} = setup(t), {c,events} = client(); await c.ready(); await c.start('QUESTION'); const q = await taskQuestion(events);
  const write = c.child.stdin.write; let attempts=0;
  try {
    c.child.stdin.write = (_chunk,callback) => { attempts++; queueMicrotask(()=>callback(new Error('fixture uncertain write'))); return true; };
    const answer={type:'reply',id:q.id,answers:skipped(q),actor:'parent'};
    await assert.rejects(c.reply(answer),/uncertain write/);
    await assert.rejects(c.reply(answer),/pending|answered/); assert.equal(attempts,1);
  } finally {c.child.stdin.write=write;await c.stop();}
});

test('Claude early unscoped approval is denied without aborting startup; malformed stdout and process death are not completions', async t => {
  const {client} = setup(t);
  const early = client(undefined, ['--early-approval']); await early.c.ready();
  assert.equal(early.events.some(e=>e.type==='question'||e.type==='settled'),false); assert(early.events.some(e=>e.type==='activity'&&/^interaction refused: can_use_tool$/.test(e.detail)));
  await early.c.stop();
  for (const task of ['NOISE', 'CRASH']) {
    const {c, events} = client(); await c.ready(); await assert.rejects(c.start(task), /JSON|exited|record/i);
    assert(!events.some(e=>e.type==='settled' && e.status==='completed')); await c.stop();
  }
});

test('Claude activity describes the current step instead of the raw stream-json record type', async t => {
  const { client } = setup(t); const { c, events } = client();
  await c.ready(); await c.start('STREAM_LABELS', 'labels');
  assert.equal((await terminal(events)).text, 'STREAM_LABELS');
  const labels = events.filter(e => e.type === 'activity').map(e => e.detail);
  // Two deltas and two block stops add nothing: only a step start is a label. An unnameable block
  // still produces one, so its step stays visible and keeps the state file's liveness fresh.
  assert.deepEqual(labels, ['Thinking', 'Thinking', 'Writing a reply', 'Writing a reply', 'Using Write', 'Using Write', 'Using Write', 'Working', 'Reading tool results']);
  await c.end();
});
