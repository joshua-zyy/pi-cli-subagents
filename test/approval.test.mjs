import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import extension from '../dist/index.js';
import { AgentManager } from '../dist/manager.js';
import { waitUntil, processAlive } from '../dist/storage.js';

const fixture = fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url));
const out = path.resolve('.test-output');fs.mkdirSync(out,{recursive:true});
test('parent can explicitly review a child request while the human command remains available', {timeout:12000}, async t=>{
  const saved = process.argv[1];process.argv[1] = fixture;
  const cwd = fs.mkdtempSync(path.join(out,'approve-'));
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
  assert.equal(pending[0].questions[0].message,'Requires a human answer');
  await assert.rejects(invoke('subagent_reply',{id,questionId:'other',confirmed:true,reason:'not the current request'}),/ended|exist/);
  await assert.rejects(invoke('subagent_reply',{id,questionId:'permission-1',value:'bad',reason:'wrong answer type'}),/type/);
  assert.equal(manager.get(id).phase,'waiting');
  // A Pi confirm can mean "remember this", so the parent agent may refuse but never approve it.
  await assert.rejects(invoke('subagent_reply',{id,questionId:'permission-1',confirmed:true,reason:'Within the parent-assigned task'}),/parent|human/i);
  assert.equal(manager.get(id).phase,'waiting','a refused approval must leave the request pending');
  await invoke('subagent_reply',{id,questionId:'permission-1',confirmed:false,reason:'Not authorized for this task'});
  await waitUntil('complete',()=>manager.get(id).phase==='completed'&&!processAlive(manager.get(id).workerPid));
  assert.equal(confirmations,0);
  assert.equal(manager.get(id).text,'DENY');
  assert.deepEqual(await waiting(),[]);
  await assert.rejects(invoke('subagent_reply',{id,questionId:'permission-1',confirmed:true,reason:'duplicate'}),/ended|exist|exited/);
  const audit=fs.readFileSync(path.join(manager.root,id,'runs',manager.get(id).runId,'permissions.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(audit.length,1,'a refused approval must not be recorded as a decision'); assert.equal(audit[0].actor,'parent'); assert.equal(audit[0].reason,'Not authorized for this task');
  assert.equal(audit[0].decision,'denied');
  const second=JSON.parse((await invoke('subagent',{ action: 'start',role:'worker',task:'WAIT',cwd})).match(/\{.+\}/)[0]);
  await waitUntil('human waiting',()=>manager.get(second.id).phase==='waiting');
  await commands.get('agent-reply').handler(`${second.id} permission-1`,ctx);
  await waitUntil('human complete',()=>manager.get(second.id).phase==='completed'&&!processAlive(manager.get(second.id).workerPid));
  assert.equal(confirmations,1);assert.equal(manager.get(second.id).text,'DENY');
  assert.ok(notices.some(message=>message.includes('Human response sent to subagent')));
});

test('permission tools reject foreign parents, missing persistent sessions and invalid decisions', {timeout:12000}, async t=>{
  const saved=process.argv[1];process.argv[1]=fixture;
  const cwd=fs.mkdtempSync(path.join(out,'permission-scope-'));
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
  // An unrecognized option set carries no audited meaning, so no value from it may be approved.
  await assert.rejects(invoke('subagent_reply',{id:select.id,questionId:'permission-1',value:'Deny',reason:'Not authorized'}),/parent|human/i);
  assert.equal(manager.get(select.id).phase,'waiting');
  await invoke('subagent_reply',{id:select.id,questionId:'permission-1',cancelled:true,reason:'Not authorized'});
  await waitUntil('select complete',()=>manager.get(select.id).phase==='completed'&&!processAlive(manager.get(select.id).workerPid));
  assert.equal(manager.get(select.id).text,'CANCELLED');
  // The audited safety-guard contract: the parent may refuse or allow one action, never a standing grant.
  const guard=JSON.parse((await invoke('subagent',{ action: 'start',role:'worker',task:'WAIT_SAFETY',cwd})).match(/\{.+\}/)[0]);
  await waitUntil('guard waiting',()=>manager.get(guard.id).phase==='waiting');
  const guardQuestion=(await waiting()).find(entry=>entry.id===guard.id).questions[0];
  assert.deepEqual(guardQuestion.options,['Block','Allow once','Allow for this session','Always allow in this cwd']);
  for(const forbidden of ['Allow for this session','Always allow in this cwd']){
    await assert.rejects(invoke('subagent_reply',{id:guard.id,questionId:'permission-1',value:forbidden,reason:'standing grant'}),/parent|human/i);
    assert.equal(manager.get(guard.id).phase,'waiting','a refused standing grant must leave the request pending');
  }
  await invoke('subagent_reply',{id:guard.id,questionId:'permission-1',value:'Allow once',reason:'One-off read-only grep inside the assigned scope'});
  await waitUntil('guard complete',()=>manager.get(guard.id).phase==='completed'&&!processAlive(manager.get(guard.id).workerPid));
  assert.equal(manager.get(guard.id).text,'Allow once','the standing grant must never reach the child');
});
