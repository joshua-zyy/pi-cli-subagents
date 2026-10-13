import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentManager } from '../dist/manager.js';
import extension from '../dist/index.js';
import { deliverReports } from '../dist/notifier.js';
import { loadRoles } from '../dist/roles.js';
import { claudeLaunch } from '../dist/claude-launch.js';
import { waitUntil, processAlive } from '../dist/storage.js';
import { tempDir } from './helpers/tmp.mjs';
const fixture = fileURLToPath(new URL('./fixtures/claude.mjs', import.meta.url));
const pi = fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url));
const role = {cli:'claude',description:'fixture',instructions:'Only assigned work'};
const setup = t => {
  const cwd=tempDir('claude-manager'),home=path.join(cwd,'home'),parent=path.join(cwd,'parent.jsonl');
  fs.mkdirSync(home);fs.writeFileSync(path.join(home,'fixture-home'),'');fs.writeFileSync(parent,'{}\n');
  const launch={command:process.execPath,args:[pi]},options={launch:{command:process.execPath,args:[fixture]},home};
  const m=new AgentManager(parent,launch,undefined,options);
  t.after(async()=>{for(const s of m.list())if(processAlive(s.workerPid))await m.close(s.id);});
  const done=async(id,status='completed')=>{
    const state=await waitUntil('run result',()=>{const s=m.get(id);return ['idle','closed'].includes(s.phase)?s:undefined;},12000);
    assert.equal(state.lastStatus,status);
    if(state.cli==='claude'){
      assert.equal(state.phase,'closed');
      await waitUntil('Claude worker release',()=>!processAlive(state.workerPid),5000);
    }
    return state;
  };
  return{m,cwd,home,parent,launch,options,done};
};
function publicApi(parent,cwd,ui={}) {
  const tools=new Map(),commands=new Map(),messages=[],notices=[];
  const ctx={cwd,hasUI:true,isProjectTrusted:()=>false,sessionManager:{getSessionFile:()=>parent,getEntries:()=>[]},
    ui:{notify:message=>notices.push(message),setStatus(){},...ui}};
  extension({on(){},registerTool:tool=>tools.set(tool.name,tool),registerCommand:(name,command)=>commands.set(name,command),
    registerShortcut(){},registerMessageRenderer(){},sendMessage:message=>messages.push(message)});
  const invoke=async(name,args)=>(await tools.get(name).execute('fixture',args,undefined,undefined,ctx)).content[0].text;
  return {ctx,commands,messages,notices,invoke};
}
test('Claude native launch resolution fails before registering an incomplete instance', {skip:process.platform!=='win32'}, async t=>{
  const {m,cwd,parent,launch,done}=setup(t);
  const existing=await m.spawn('worker',{description:'Pi fixture',instructions:'test'},cwd,'REMEMBER old');await done(existing.id);
  const native=new AgentManager(parent,launch);const original=process.env.PATH;
  try {
    process.env.PATH=cwd;fs.writeFileSync(path.join(cwd,'claude.cmd'),'not an executable');
    await assert.rejects(native.spawn('claude',role,cwd,'DO NOT START'),/native CLI.*PATH/);
    assert.equal(native.list().length,1);assert.equal(native.list()[0].id,existing.id);assert(native.reports().length);
    fs.writeFileSync(path.join(cwd,'claude.exe'),'');
    assert.deepEqual(claudeLaunch(),{command:path.join(cwd,'claude.exe'),args:[]});
  } finally { if(original===undefined)delete process.env.PATH;else process.env.PATH=original; }
});
test('Claude roles take a native --effort level and reject Pi provider and Codex effort',t=>{
  const {cwd}=setup(t),file=path.join(cwd,'cli-subagents.roles.json');fs.writeFileSync(file,JSON.stringify({claude:role}));
  assert.deepEqual(loadRoles(cwd,cwd,false).claude,role);
  fs.writeFileSync(file,JSON.stringify({claude:{...role,thinking:'max'}}));
  assert.deepEqual(loadRoles(cwd,cwd,false).claude,{...role,thinking:'max'});
  fs.writeFileSync(file,JSON.stringify({claude:{...role,mode:'bypassPermissions'}}));
  assert.deepEqual(loadRoles(cwd,cwd,false).claude,{...role,mode:'bypassPermissions'});
  for(const extra of [{provider:'pi'},{thinking:'off'},{thinking:'minimal'},{effort:'high'},{mode:'full-access'},{mode:'bypass'}]){
    fs.writeFileSync(file,JSON.stringify({claude:{...role,...extra}}));assert.throws(()=>loadRoles(cwd,cwd,false),/Claude|cli: codex|effort/);
  }
});
test('Claude role thinking and mode are passed to the native CLI as --effort and --permission-mode', {timeout:25000}, async t=>{
  const {m,cwd,home,done}=setup(t);
  const child=await m.spawn('claude',{...role,model:'opus',thinking:'max',mode:'plan'},cwd,'DONE');await done(child.id);
  const launched=JSON.parse(fs.readFileSync(path.join(home,'launches.jsonl'),'utf8').trim().split('\n')[0]).args;
  assert.equal(launched[launched.indexOf('--model')+1],'opus');assert.equal(launched[launched.indexOf('--effort')+1],'max');
  assert.equal(launched[launched.indexOf('--permission-mode')+1],'plan');
});
test('Claude manager reopens the same native session and retains prior home/model selection', {timeout:25000}, async t=>{
  const {m,cwd,home,parent,launch,options,done}=setup(t);
  const child=await m.spawn('claude',role,cwd,'REMEMBER alpha');const first=await done(child.id);
  assert.equal(first.cli,'claude');assert.equal(first.session.claudeHome,home);assert.equal(first.sessionFile,undefined);
  const log=path.join(home,'projects','fixture-project',`${first.sessionId}.jsonl`);
  fs.appendFileSync(log,JSON.stringify({type:'attachment',sessionId:first.sessionId,cwd:path.join(cwd,'apps','cli'),isSidechain:false})+'\n');
  const reopened=new AgentManager(parent,launch,undefined,{...options,home:path.join(cwd,'different')});
  await reopened.send(child.id,'RECALL');const second=await done(child.id);
  assert.equal(second.text,'alpha');assert.deepEqual(second.session,first.session);assert.equal(second.runCount,2);
  assert.equal(m.reports().filter(r=>r.status==='completed').length,2);
  fs.unlinkSync(log);
  await assert.rejects(reopened.send(child.id,'NO REPLACEMENT'),/missing/);assert.equal(m.get(child.id).runCount,2);
});
test('Claude public query and parent reply preserve the native task, report fields and one question audit', {timeout:20000}, async t=>{
  const {m,cwd,home,parent,done}=setup(t), {ctx,invoke}=publicApi(parent,cwd,{select(){throw Error('No human escalation');},input(){throw Error('No human escalation');}});
  const child=await m.spawn('claude',role,cwd,'QUESTION');
  const waiting=await waitUntil('Claude task form',()=>{const state=m.get(child.id);return state.questions.length?state:undefined;});
  const view=JSON.parse(await invoke('subagent_query',{action:'get',id:child.id})).agents[0],q=view.questions[0];
  assert.equal(view.phase,'waiting');assert.equal(q.kind,'question');assert.equal(q.fields[1].multiSelect,true);
  assert.equal(q.fields[0].options[0].preview,'<pre>work.txt</pre>');
  const report=m.reports().find(r=>r.status==='waiting');assert.deepEqual(report.request.fields,q.fields);
  const notices=[];deliverReports(m,{sendMessage:message=>notices.push(message)},ctx,new Set(),Date.now());
  assert.equal(notices.length,1);assert.match(notices[0].content,/subagent_reply/);assert.match(notices[0].content,/Which outputs/);
  const answers={'Which checks?':['Review'],'Which outputs?':['Logs','Summary'],'What marker?':['CLAUDE-QA-offline'],'How many items?':['3']};
  const reply={id:child.id,questionId:q.id,reason:'Only supplying the assigned fixture task context'};
  for(const invalid of [{value:'Approve once'},{answers:{}},{answers:{...answers,'What marker?':['x'.repeat(8193)]}}])
    await assert.rejects(invoke('subagent_reply',{...reply,...invalid}),/field|form|limit|large/i);
  const auditFile=path.join(m.root,child.id,'runs',waiting.runId,'permissions.jsonl');
  assert.equal(fs.existsSync(auditFile),false,'invalid native answers must fail before the audit boundary');
  await invoke('subagent_reply',{...reply,answers});const result=await done(child.id);
  assert.equal(result.runId,waiting.runId);assert.deepEqual(result.session,waiting.session);
  assert.deepEqual(JSON.parse(result.text),{'Which checks?':'Review','Which outputs?':['Logs','Summary'],'What marker?':'CLAUDE-QA-offline','How many items?':'3'});
  const audit=fs.readFileSync(auditFile,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(audit.length,1);assert.equal(audit[0].actor,'parent');assert.equal(audit[0].kind,'question');assert.equal(audit[0].decision,'answered');
  const requests=fs.readFileSync(path.join(home,'requests.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(requests.filter(r=>r.type==='user').length,1);assert.equal(requests.filter(r=>r.type==='control_response').length,1);
  await assert.rejects(invoke('subagent_reply',{...reply,answers}),/ended|exist|exited|finished/i);
});

test('Claude native rule-forced questions show the signal to the parent and still accept one complete human form', {timeout:20000}, async t=>{
  const {m,cwd,parent,done}=setup(t);let multiPrompts=0;
  const {ctx,commands,notices,messages}=publicApi(parent,cwd,{
    select:async(title,options)=>{
      assert.doesNotMatch(title,/Human response required/);
      if(title.includes('Which checks?'))return options[0];
      assert.match(title,/Which outputs/);return multiPrompts++===0?options[0]:options.find(value=>/^\d+\. Finish selection\./.test(value));
    },
    input:async title=>title.includes('What marker?')?'HUMAN-CONTEXT':'4',
  });
  const child=await m.spawn('claude',role,cwd,'QUESTION_RULE');
  const q=await waitUntil('native rule-forced form',()=>m.get(child.id).questions[0]);
  assert.notEqual(q.humanOnly,true);assert.deepEqual(q.parentPolicy,{answers:true});
  await commands.get('agent-reply').handler(`${child.id} ${q.id}`,ctx);const result=await done(child.id);
  assert.deepEqual(JSON.parse(result.text),{'Which checks?':'Read, write','Which outputs?':['Logs'],'What marker?':'HUMAN-CONTEXT','How many items?':'4'});
  assert(notices.some(message=>/Human response accepted/.test(message)));
  assert.equal(messages.filter(message=>message.customType==='cli-subagents-human-action').length,1);
  const audit=fs.readFileSync(path.join(m.root,child.id,'runs',result.runId,'permissions.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(audit.length,1);assert.equal(audit[0].actor,'human');assert.equal(audit[0].decision,'answered');
});

test('Claude parent decisions on signalled approvals are scoped and audited; close retains native history', {timeout:25000}, async t=>{
  const {m,cwd,home,done}=setup(t);
  const child=await m.spawn('claude',role,cwd,'APPROVAL_MANUAL');
  const waiting=await waitUntil('Claude waiting',()=>{const s=m.get(child.id);return s.questions.length?s:undefined;});const q=waiting.questions[0];
  assert.notEqual(q.humanOnly,true);assert.deepEqual(q.parentPolicy,{values:['Deny once','Approve once','Cancel turn']});
  await m.reply(child.id,q.id,{value:'Approve once'},{actor:'parent',reason:'task scope'});const finished=await done(child.id);assert.equal(finished.text,'ALLOW');
  const audit=fs.readFileSync(path.join(m.root,child.id,'runs',finished.runId,'permissions.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(audit.length,1);assert.equal(audit[0].actor,'parent');assert.equal(audit[0].reason,'task scope');assert.equal(audit[0].selectedOption,'Approve once');
  const held=await m.spawn('claude',role,cwd,'HOLD');await assert.rejects(m.send(held.id,'steer'),/steer.*not supported/);
  const heldState=m.get(held.id);
  const log=path.join(home,'projects','fixture-project',`${heldState.sessionId}.jsonl`);
  fs.appendFileSync(log,JSON.stringify({type:'attachment',sessionId:heldState.sessionId,cwd:path.join(cwd,'apps','cli'),isSidechain:false})+'\n');
  await m.close(held.id);const stopped=await done(held.id,'stopped');assert(stopped.sessionId);assert.equal(stopped.forced,false);
  await m.send(held.id,'CWD');const resumed=await done(held.id);
  assert.equal(resumed.sessionId,stopped.sessionId);assert.equal(resumed.text,cwd);
});
