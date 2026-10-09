import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import extension from '../dist/index.js';
import { AgentManager } from '../dist/manager.js';
import { deliverReports } from '../dist/notifier.js';
import { waitUntil, processAlive } from '../dist/storage.js';
import { tempDir } from './helpers/tmp.mjs';

const fixture = fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url));
test('parent can explicitly review a child request while the human command remains available', {timeout:12000}, async t=>{
  const saved = process.argv[1];process.argv[1] = fixture;
  const cwd = tempDir('approve');
  const parent = path.join(cwd,'parent.jsonl');fs.writeFileSync(parent,'{}\n');
  const tools = new Map(), commands = new Map(), notices=[];
  let confirmations=0;
  const ctx = {cwd, hasUI:true, isProjectTrusted:()=>false,
    sessionManager:{ getSessionFile:()=>parent, getEntries:()=>[] },
    ui:{notify:(message)=>notices.push(message),confirm:async()=>{confirmations++;return false;}}};
  extension({on(){},registerTool(tool){tools.set(tool.name,tool)},registerCommand(name,def){commands.set(name,def)},registerShortcut(){},registerMessageRenderer(){}});
  const manager = new AgentManager(parent,{command:process.execPath,args:[fixture]});
  t.after(async()=>{for(const s of manager.list())if(processAlive(s.workerPid))await manager.close(s.id);process.argv[1]=saved;});
  assert.ok(tools.has('subagent_query'));
  assert.ok(tools.has('subagent_reply'));
  assert.equal(tools.has('agent-reply'),false);
  const result = await tools.get('subagent').execute('id',{action:'start',role:'worker',task:'WAIT',cwd},undefined,undefined,ctx);
  const id = JSON.parse(result.content[0].text.match(/\{.+\}/)[0]).id;
  await waitUntil('waiting',()=>manager.get(id).phase==='waiting');
  assert.equal(confirmations,0);
  const invoke = async (name, args, context=ctx) => (await tools.get(name).execute('id',args,undefined,undefined,context)).content[0].text;
  // The roster is the only listing tool; a `waiting` instance carries its unresolved request.
  const waiting = async (context=ctx) => JSON.parse(await invoke('subagent_query',{action:'list'},context)).agents.filter(agent=>agent.phase==='waiting');
  const pending=await waiting();
  assert.equal(pending.length,1); assert.equal(pending[0].id,id);
  assert.equal(pending[0].questions[0].id,'permission-1');
  assert.equal(pending[0].questions[0].message,'Confirm this fixture-only action');
  assert.equal(pending[0].questions[0].humanOnly,false);
  assert.deepEqual(pending[0].questions[0].parentPolicy,{confirm:true});
  await assert.rejects(invoke('subagent_reply',{id,questionId:'other',confirmed:true,reason:'not the current request'}),/ended|exist/);
  await assert.rejects(invoke('subagent_reply',{id,questionId:'permission-1',value:'bad',reason:'wrong answer type'}),/type/);
  assert.equal(manager.get(id).phase,'waiting');
  // A native Pi confirm is delivered to the parent, not classified by button wording.
  await invoke('subagent_reply',{id,questionId:'permission-1',confirmed:true,reason:'Confirm the authorized fixture-only action'});
  await waitUntil('complete',()=>manager.get(id).phase==='completed'&&!processAlive(manager.get(id).workerPid));
  assert.equal(confirmations,0);
  assert.equal(manager.get(id).text,'ALLOW');
  assert.deepEqual(await waiting(),[]);
  await assert.rejects(invoke('subagent_reply',{id,questionId:'permission-1',confirmed:true,reason:'duplicate'}),/ended|exist|exited/);
  const audit=fs.readFileSync(path.join(manager.root,id,'runs',manager.get(id).runId,'permissions.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(audit.length,1,'only the valid parent response is recorded'); assert.equal(audit[0].actor,'parent'); assert.equal(audit[0].reason,'Confirm the authorized fixture-only action');
  assert.equal(audit[0].decision,'approved');
  const second=JSON.parse((await invoke('subagent',{ action: 'start',role:'worker',task:'WAIT',cwd})).match(/\{.+\}/)[0]);
  await waitUntil('human waiting',()=>manager.get(second.id).phase==='waiting');
  await commands.get('agent-reply').handler(`${second.id} permission-1`,ctx);
  await waitUntil('human complete',()=>manager.get(second.id).phase==='completed'&&!processAlive(manager.get(second.id).workerPid));
  assert.equal(confirmations,1);assert.equal(manager.get(second.id).text,'DENY');
  assert.ok(notices.some(message=>message.includes('Human response accepted for subagent')));
});

test('parent refusal of a Pi confirmation reaches the child and records denial', {timeout:8000}, async t=>{
  const cwd=tempDir('pi-refusal'),parent=path.join(cwd,'parent.jsonl');fs.writeFileSync(parent,'{}\n');
  const manager=new AgentManager(parent,{command:process.execPath,args:[fixture]});
  t.after(async()=>{for(const state of manager.list())if(processAlive(state.workerPid))await manager.close(state.id);});
  const started=await manager.spawn('worker',{description:'fixture',instructions:'Only fixture interactions'},cwd,'WAIT');
  const q=await waitUntil('confirmation',()=>manager.get(started.id).questions[0]);
  await manager.reply(started.id,q.id,{confirmed:false},{actor:'parent',reason:'Not authorized'});
  const final=await waitUntil('refusal completed',()=>{
    const state=manager.get(started.id);return state.phase==='completed'&&!processAlive(state.workerPid)?state:undefined;
  });
  assert.equal(final.text,'DENY');
  const audit=fs.readFileSync(path.join(manager.root,started.id,'runs',started.runId,'permissions.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(audit.length,1);assert.equal(audit[0].actor,'parent');assert.equal(audit[0].decision,'denied');
});

test('permission tools reject foreign parents, missing persistent sessions and invalid decisions', {timeout:12000}, async t=>{
  const saved=process.argv[1];process.argv[1]=fixture;
  const cwd=tempDir('permission-scope');
  const parent=path.join(cwd,'parent.jsonl'),foreign=path.join(cwd,'foreign.jsonl');
  fs.writeFileSync(parent,'{}\n');fs.writeFileSync(foreign,'{}\n');
  const tools=new Map();extension({on(){},registerTool(tool){tools.set(tool.name,tool)},registerCommand(){},registerShortcut(){},registerMessageRenderer(){}});
  const manager=new AgentManager(parent,{command:process.execPath,args:[fixture]});
  t.after(async()=>{for(const state of manager.list())if(processAlive(state.workerPid))await manager.close(state.id);process.argv[1]=saved;});
  let current=parent;
  const context={cwd,isProjectTrusted:()=>false,sessionManager:{getSessionFile:()=>current}};
  const invoke=async(name,args)=>(await tools.get(name).execute('id',args,undefined,undefined,context)).content[0].text;
  const waiting=async()=>JSON.parse(await invoke('subagent_query',{action:'list'})).agents.filter(agent=>agent.phase==='waiting');
  const spawned=JSON.parse((await invoke('subagent',{ action: 'start',role:'worker',task:'WAIT',cwd})).match(/\{.+\}/)[0]);
  await waitUntil('waiting',()=>manager.get(spawned.id).phase==='waiting');
  await assert.rejects(invoke('subagent_reply',{id:spawned.id,questionId:'permission-1',confirmed:true,value:'mixed',reason:'invalid'}),/exactly|type|response/i);
  await assert.rejects(invoke('subagent_reply',{id:spawned.id,questionId:'permission-1',confirmed:true,reason:'  '}),/reason/i);
  current=foreign;
  assert.deepEqual(await waiting(),[]);
  await assert.rejects(invoke('subagent_reply',{id:spawned.id,questionId:'permission-1',confirmed:true,reason:'foreign'}),/belong|missing/i);
  current=undefined;
  await assert.rejects(invoke('subagent_query',{action:'list'}),/persistent parent session/);
  current=parent;
  assert.equal(manager.get(spawned.id).phase,'waiting');
  const select=JSON.parse((await invoke('subagent',{ action: 'start',role:'worker',task:'WAIT_SELECT',cwd})).match(/\{.+\}/)[0]);
  await waitUntil('select waiting',()=>manager.get(select.id).phase==='waiting');
  const options=(await waiting()).find(entry=>entry.id===select.id).questions[0].options;
  assert.deepEqual(options,['Allow once','Deny']);
  await assert.rejects(invoke('subagent_reply',{id:select.id,questionId:'permission-1',confirmed:true,reason:'wrong method'}),/type/);
  await assert.rejects(invoke('subagent_reply',{id:select.id,questionId:'permission-1',value:'Allow forever',reason:'not offered'}),/available options/);
  await invoke('subagent_reply',{id:select.id,questionId:'permission-1',value:'Deny',reason:'Not authorized'});
  await waitUntil('select complete',()=>manager.get(select.id).phase==='completed'&&!processAlive(manager.get(select.id).workerPid));
  assert.equal(manager.get(select.id).text,'Deny');
  // All native labels remain visible; the parent's authorization judgment chooses the narrow action.
  const guard=JSON.parse((await invoke('subagent',{ action: 'start',role:'worker',task:'WAIT_SAFETY',cwd})).match(/\{.+\}/)[0]);
  await waitUntil('guard waiting',()=>manager.get(guard.id).phase==='waiting');
  const guardQuestion=(await waiting()).find(entry=>entry.id===guard.id).questions[0];
  assert.deepEqual(guardQuestion.options,['Block','Allow once','Allow for this session','Always allow in this cwd']);
  assert.equal(guardQuestion.humanOnly,false);
  const guardReport=manager.reports().find(report=>report.agentId===guard.id&&report.status==='waiting');
  assert.deepEqual(guardReport.request.parentPolicy,{values:guardQuestion.options});
  const sent=[],warnings=[];
  deliverReports(manager,{sendMessage:message=>sent.push(message)},{sessionManager:{getEntries:()=>[]},ui:{notify:message=>warnings.push(message),setStatus(){}}},new Set(),Date.now());
  const guardContent=sent.find(message=>message.content.includes(guard.id)).content;
  assert.match(guardContent,/offered: "Block", "Allow once", "Allow for this session", "Always allow in this cwd"/);
  assert.match(guardContent,/Handle this request now with subagent_reply within the user's task authorization/);
  assert.match(guardContent,/not proof.*authoriz/i);
  assert.match(guardContent,/user.*requires.*confirmation/i);
  assert.deepEqual(warnings,[]);
  await invoke('subagent_reply',{id:guard.id,questionId:'permission-1',value:'Allow once',reason:'One-off read-only grep inside the assigned scope'});
  await waitUntil('guard complete',()=>manager.get(guard.id).phase==='completed'&&!processAlive(manager.get(guard.id).workerPid));
  assert.equal(manager.get(guard.id).text,'Allow once');
});

test('parent replies to native Pi text dialogs once while cancellations and expiration stay scoped', {timeout:15000}, async t=>{
  const cwd=tempDir('pi-dialog'),parent=path.join(cwd,'parent.jsonl');fs.writeFileSync(parent,'{}\n');
  const tools=new Map();extension({on(){},registerTool:tool=>tools.set(tool.name,tool),registerCommand(){},registerShortcut(){},registerMessageRenderer(){}});
  const manager=new AgentManager(parent,{command:process.execPath,args:[fixture]});
  t.after(async()=>{for(const state of manager.list())if(processAlive(state.workerPid))await manager.close(state.id);});
  const warnings=[],sent=[],ctx={cwd,sessionManager:{getSessionFile:()=>parent,getEntries:()=>[]},ui:{notify:message=>warnings.push(message),setStatus(){}}};
  const invoke=args=>tools.get('subagent_reply').execute('test',args,undefined,undefined,ctx);
  for(const [task,answer,expected] of [
    ['WAIT_INPUT',{value:'literal, 雪'},'literal, 雪'],['WAIT_EDITOR',{value:'two\nlines'},'two\nlines'],
    ['WAIT_INPUT',{cancelled:true},'CANCELLED'],['WAIT_EXPIRED',null,'EXPIRED'],
  ]) {
    const started=await manager.spawn('worker',{description:'fixture',instructions:'Only fixture interactions'},cwd,task);
    const q=await waitUntil('native dialog',()=>manager.get(started.id).questions[0]);
    assert.equal(q.kind,undefined,'a generic dialog is not authenticated as a task question');
    assert.deepEqual(q.parentPolicy,{text:true});assert.equal(q.humanOnly,false);
    assert.equal(q.method,task==='WAIT_EDITOR'?'editor':'input');
    if(q.method==='editor')assert.equal(q.prefill,'original\ncontext');else assert.equal(q.placeholder,'exact text');
    deliverReports(manager,{sendMessage:(message,options)=>sent.push({message,options})},ctx,new Set(),Date.now(),manager.list());
    const notice=sent.find(row=>row.message.content.includes(started.id));assert.equal(notice.options.deliverAs,'steer');
    assert.match(notice.message.content,/value as response text/);assert.doesNotMatch(notice.message.content,/not a permission request/);
    const args={id:started.id,questionId:q.id,reason:'Authorized fixture context'};
    if(answer) {
      await assert.rejects(invoke({...args,confirmed:true}),/type/);
      await assert.rejects(invoke({...args,answers:{field:['wrong contract']}}),/type/);
      await invoke({...args,...answer});
    }
    const final=await waitUntil('original run completed',()=>{
      const state=manager.get(started.id);return state.phase==='completed'&&!processAlive(state.workerPid)?state:undefined;
    });
    assert.equal(final.runId,started.runId);assert.equal(final.sessionId,started.sessionId);assert.equal(final.text,expected);
    assert.deepEqual(final.questions,[]);
    await assert.rejects(invoke({...args,value:'late reply'}),/ended|exited|exist/);
    const auditFile=path.join(manager.root,started.id,'runs',started.runId,'permissions.jsonl');
    if(answer) {
      const audit=fs.readFileSync(auditFile,'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(audit.length,1);assert.equal(audit[0].actor,'parent');
      assert.equal(audit[0].decision,answer.cancelled?'cancelled':'answered');
      assert.equal(JSON.parse(fs.readFileSync(final.sessionFile,'utf8')).messages.filter(m=>m.role==='user').length,1);
    } else assert.equal(fs.existsSync(auditFile),false,'an expired unanswered dialog produces no attempted-answer audit');
  }
  assert.deepEqual(warnings,[]);
});

test('owned Pi questions accept parent choices, custom text and cancellation in the original run', {timeout:15000}, async t=>{
  const saved=process.argv[1];process.argv[1]=fixture;
  const cwd=tempDir('parent-question'),parent=path.join(cwd,'parent.jsonl');fs.writeFileSync(parent,'{}\n');
  const tools=new Map();extension({on(){},registerTool(tool){tools.set(tool.name,tool)},registerCommand(){},registerShortcut(){},registerMessageRenderer(){}});
  const manager=new AgentManager(parent,{command:process.execPath,args:[fixture]});
  t.after(async()=>{for(const state of manager.list())if(processAlive(state.workerPid))await manager.close(state.id);process.argv[1]=saved;});
  const warnings=[],statuses=[],sent=[];
  const ctx={cwd,isProjectTrusted:()=>false,sessionManager:{getSessionFile:()=>parent,getEntries:()=>[]},
    ui:{notify:message=>warnings.push(message),setStatus:(_key,value)=>statuses.push(value),select:()=>{throw new Error('Do not ask the human for task context');}}};
  const invoke=async(name,args)=>(await tools.get(name).execute('test',args,undefined,undefined,ctx)).content[0].text;
  const notify=()=>deliverReports(manager,{sendMessage:(message,options)=>sent.push({message,options})},ctx,new Set(),Date.now(),manager.list());
  let existingId,originalSessionId,taskCount=0;
  for(const mode of ['custom','option','cancel']){
    const initial=JSON.parse((await invoke('subagent',existingId
      ? {action:'send',id:existingId,message:'ASK_PARENT'}
      : {action:'start',role:'worker',task:'ASK_PARENT',cwd})).match(/\{.+\}/)[0]);
    const {id,runId,sessionId}=initial;
    if(existingId){assert.equal(id,existingId);assert.equal(sessionId,originalSessionId);}
    existingId=id;originalSessionId=sessionId;taskCount++;
    const q=await waitUntil('owned question',()=>manager.get(id).questions[0],3000);
    assert.equal(q.kind,'question');assert.equal(q.humanOnly,false);
    notify();
    const notice=sent.find(s=>s.message.content.includes(q.id));
    assert.equal(notice.options.deliverAs,'steer');assert.match(notice.message.content,/task question/i);
    assert.match(notice.message.content,/offered label or your custom answer/);
    // The caller submits one logical answer, never a menu entry followed by a second reply.
    await invoke('subagent_reply',{id,questionId:q.id,reason:'Use the agreed verification scope',
      ...(mode==='cancel'?{cancelled:true}:{value:mode==='custom'?'Only the focused regression.':'Unit'})});
    await waitUntil('question run completion',()=>manager.get(id).phase==='completed'&&!processAlive(manager.get(id).workerPid),4000);
    const state=manager.get(id);assert.equal(state.runId,runId);assert.equal(state.sessionId,sessionId);assert.deepEqual(state.questions,[]);
    const result=JSON.parse(await invoke('subagent_query',{action:'result',id,runId}));
    const answer=JSON.parse(result.text);
    assert.equal(answer.cancelled,mode==='cancel');
    if(mode!=='cancel'){
      assert.equal(answer.answers[0].kind,mode==='custom'?'custom':'option');
      assert.equal(answer.answers[0].answer,mode==='custom'?'Only the focused regression.':'Unit');
    }
    const native=JSON.parse(fs.readFileSync(state.session.sessionFile,'utf8'));
    assert.equal(native.messages.filter(m=>m.role==='user').length,taskCount,'answering must not submit a replacement task');
    const events=fs.readFileSync(state.logFile,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(e=>e.type==='agent_start').length,1);
    const audit=fs.readFileSync(path.join(manager.root,id,'runs',runId,'permissions.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(audit.length,1);assert(audit.every(row=>row.actor==='parent'&&row.runId===runId));
    assert(audit.every(row=>row.kind==='question'&&['answered','cancelled'].includes(row.decision)));
    if(mode==='custom')assert.equal(audit[0].selectedOption,undefined,'free text is not an option or a permission grant');
  }
  assert.deepEqual(warnings,[]);assert(statuses.some(s=>s?.includes('waiting for parent review')));
});
