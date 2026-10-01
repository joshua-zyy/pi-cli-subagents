// Real local Git repositories, fake CLIs, no model or credential access.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {AgentManager} from '../dist/manager.js';import {processAlive,waitUntil} from '../dist/storage.js';
const fixture=fileURLToPath(new URL('./fixtures/claude.mjs',import.meta.url)),pi=fileURLToPath(new URL('./fixtures/pi.mjs',import.meta.url));
const role={cli:'claude',description:'test',instructions:'Only the assigned task'},piRole={description:'review',instructions:'Read only'};
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',windowsHide:true});
const fileTask=(file,content)=>`FILE ${JSON.stringify({file,...(content===undefined?{}:{content})})}`;
const sync={baseline:'sync',includeUncommitted:{reason:'User authorized these fixture changes'}};
function setup(t,flags=[]){
 const root=fs.mkdtempSync(path.resolve('.test-output/claude-workspace-')),repo=path.join(root,'repo'),home=path.join(root,'home'),parent=path.join(root,'parent.jsonl');
 fs.mkdirSync(repo);fs.mkdirSync(home);fs.writeFileSync(path.join(home,'fixture-home'),'');fs.writeFileSync(parent,'{}\n');
 git(repo,'init','-q');git(repo,'config','user.name','Test');git(repo,'config','user.email','test@example.invalid');git(repo,'config','core.autocrlf','false');
 fs.writeFileSync(path.join(repo,'base.txt'),'base\n');git(repo,'add','.');git(repo,'commit','-qm','fixture');
 const launch={command:process.execPath,args:[pi]},options={launch:{command:process.execPath,args:[fixture,...flags]},home};
 const m=new AgentManager(parent,launch,undefined,options);
 t.after(async()=>{for(const s of m.list())if(processAlive(s.workerPid))await m.close(s.id);});
 const done=(id,phase='completed')=>waitUntil('Claude workspace release',()=>{const s=m.get(id);return s.phase===phase&&!processAlive(s.workerPid)?s:undefined;},12000);
 return {m,repo,home,parent,launch,options,done};
}
function snapshot(ws){return {head:git(ws.path,'rev-parse','HEAD'),index:fs.readFileSync(git(ws.path,'rev-parse','--path-format=absolute','--git-path','index').trim()).toString('base64'),files:fs.readdirSync(ws.path),base:fs.readFileSync(path.join(ws.path,'base.txt'),'utf8')};}
test('Claude workspaces isolate parallel writes, permit independent Pi review, and enforce leases', {timeout:35000}, async t=>{
 const {m,repo,done,parent,launch,options}=setup(t);const a=await m.workspaces.create(repo),b=await m.workspaces.create(repo);
 const [wa,wb]=await Promise.all([m.spawn('worker',role,repo,fileTask('a.txt','A\n'),a.id),m.spawn('worker',role,repo,fileTask('b.txt','B\n'),b.id)]);
 const [first,second]=await Promise.all([done(wa.id),done(wb.id)]);assert.notEqual(first.sessionId,second.sessionId);
 assert(!fs.existsSync(path.join(repo,'a.txt')));assert(!fs.existsSync(path.join(a.path,'b.txt')));
 const review=await m.spawn('reviewer',piRole,repo,fileTask('a.txt'),a.id);assert.equal((await done(review.id)).text,'A\n');
 for(const ws of [a,b])assert.equal((await m.workspaces.integrate(ws.id)).status,'applied');
 const held=await m.send(first.id,'HOLD','steer',{baseline:'keep'});const other=new AgentManager(parent,launch,undefined,options);
 await assert.rejects(other.spawn('reviewer',role,repo,'CWD',a.id),/occupied/);
 await assert.rejects(m.workspaces.integrate(a.id),/occupied/);await assert.rejects(m.spawn('worker',role,a.path,'CWD'),/workspace.*cwd/i);
 await m.close(held.id);await done(held.id,'stopped');
});
test('Claude keep/sync and old-reviewer continuation preserve sessions and parent HEAD/index', {timeout:35000}, async t=>{
 const {m,repo,done,home}=setup(t);fs.writeFileSync(path.join(repo,'base.txt'),'snapshot\n');
 const before={head:git(repo,'rev-parse','HEAD'),index:fs.readFileSync(path.join(repo,'.git/index'))};
 const ws=await m.workspaces.create(repo,{includeUncommitted:{reason:'Authorized initial snapshot'}});
 const worker=await m.spawn('worker',role,repo,fileTask('base.txt'),ws.id);const first=await done(worker.id);assert.equal(first.text,'snapshot\n');
 await m.send(worker.id,fileTask('base.txt','first\n'));await done(worker.id);
 const reviewer=await m.spawn('reviewer',role,repo,'CWD',ws.id);const firstReview=await done(reviewer.id);
 await m.workspaces.integrate(ws.id);fs.writeFileSync(path.join(repo,'parent.txt'),'later\n');
 await assert.rejects(m.send(worker.id,'CWD'),/baseline/i);
 await m.send(worker.id,fileTask('base.txt','second\n'),'steer',{baseline:'keep'});await done(worker.id);assert(!fs.existsSync(path.join(ws.path,'parent.txt')));
 await m.workspaces.integrate(ws.id);await m.send(worker.id,fileTask('parent.txt'),'steer',sync);const next=await done(worker.id);
 assert.equal(next.text,'later\n');assert.deepEqual(next.session,first.session);assert.equal(m.workspaces.get(ws.id).sync.status,'applied');
 await assert.rejects(m.send(reviewer.id,'CWD'),/baseline/i);await m.send(reviewer.id,fileTask('parent.txt'),'steer',{baseline:'keep'});
 const review=await done(reviewer.id);assert.deepEqual(review.session,firstReview.session);assert.equal(review.text,'later\n');
 assert.equal(git(repo,'rev-parse','HEAD'),before.head);assert.deepEqual(fs.readFileSync(path.join(repo,'.git/index')),before.index);
 const rows=fs.readFileSync(path.join(home,'requests.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert(rows.some(r=>r.type==='user'&&r.message.content.includes('Workspace baseline')));
});
test('Claude missing/foreign metadata refuses sync before Git changes or another native launch', {timeout:30000}, async t=>{
 const {m,repo,done,home}=setup(t);const ws=await m.workspaces.create(repo);const child=await m.spawn('worker',role,repo,'CWD',ws.id);const first=await done(child.id);
 fs.writeFileSync(path.join(repo,'base.txt'),'parent changed\n');
 const file=path.join(home,'projects','fixture-project',`${first.sessionId}.jsonl`),saved=fs.readFileSync(file),before=snapshot(ws),launches=fs.readFileSync(path.join(home,'launches.jsonl'));
 for(const variant of ['missing','identity','cwd']){
   if(variant==='missing')fs.unlinkSync(file);else fs.writeFileSync(file,variant==='identity'?saved.toString().replaceAll(first.sessionId,'foreign'):saved.toString().replaceAll(JSON.stringify(ws.cwd),JSON.stringify(repo)));
   await assert.rejects(m.send(child.id,'CWD','steer',sync),/missing|identity|directory/i);
   assert.deepEqual(snapshot(ws),before);assert.equal(m.get(child.id).runCount,1);assert.deepEqual(fs.readFileSync(path.join(home,'launches.jsonl')),launches);
   fs.writeFileSync(file,saved);
 }
});
test('Claude failed resume after applied sync retains original identity and unacknowledged baseline', {timeout:30000}, async t=>{
 const {m,repo,done}=setup(t,['--reject-resume']);const ws=await m.workspaces.create(repo);const child=await m.spawn('worker',role,repo,'CWD',ws.id);const first=await done(child.id);
 fs.writeFileSync(path.join(repo,'base.txt'),'synced\n');await m.send(child.id,'CWD','steer',sync);const failed=await done(child.id,'failed');
 assert.match(failed.error,/resume rejected/);assert.equal(failed.accepted,false);assert.deepEqual(failed.session,first.session);assert.deepEqual(failed.workspaceBaseline,first.workspaceBaseline);
 const record=m.workspaces.get(ws.id);assert.equal(record.sync.status,'applied');assert(fs.existsSync(record.sync.backupFile));assert.equal(fs.readFileSync(path.join(ws.path,'base.txt'),'utf8'),'synced\n');
 await assert.rejects(m.send(child.id,'CWD'),/baseline/i);
});
