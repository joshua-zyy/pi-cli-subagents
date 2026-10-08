import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentManager } from '../dist/manager.js';
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
  const done=(id,phase='completed')=>waitUntil('Claude worker release',()=>{const s=m.get(id);return s.phase===phase&&!processAlive(s.workerPid)?s:undefined;},12000);
  return{m,cwd,home,parent,launch,options,done};
};
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
  const reopened=new AgentManager(parent,launch,undefined,{...options,home:path.join(cwd,'different')});
  await reopened.send(child.id,'RECALL');const second=await done(child.id);
  assert.equal(second.text,'alpha');assert.deepEqual(second.session,first.session);assert.equal(second.runCount,2);
  assert.equal(m.reports().filter(r=>r.status==='completed').length,2);
  const log=path.join(home,'projects','fixture-project',`${first.sessionId}.jsonl`);fs.unlinkSync(log);
  await assert.rejects(reopened.send(child.id,'NO REPLACEMENT'),/missing/);assert.equal(m.get(child.id).runCount,2);
});
test('Claude parent/human decisions are scoped and audited; close retains native history', {timeout:25000}, async t=>{
  const {m,cwd,done}=setup(t);
  const child=await m.spawn('claude',role,cwd,'APPROVAL_MANUAL');
  const waiting=await waitUntil('Claude waiting',()=>{const s=m.get(child.id);return s.questions.length?s:undefined;});const q=waiting.questions[0];
  await assert.rejects(m.reply(child.id,q.id,{value:'Approve once'},{actor:'parent',reason:'task scope'}),/human/);
  await m.reply(child.id,q.id,{value:'Approve once'},{actor:'human'});const finished=await done(child.id);assert.equal(finished.text,'ALLOW');
  const audit=fs.readFileSync(path.join(m.root,child.id,'runs',finished.runId,'permissions.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(audit.length,1);assert.equal(audit[0].actor,'human');assert.equal(audit[0].selectedOption,'Approve once');
  const held=await m.spawn('claude',role,cwd,'HOLD');await assert.rejects(m.send(held.id,'steer'),/steer.*not supported/);
  await m.close(held.id);const stopped=await done(held.id,'stopped');assert(stopped.sessionId);assert.equal(stopped.forced,false);
  await m.send(held.id,'RECALL');assert.equal((await done(held.id)).sessionId,stopped.sessionId);
});
