// Extension wiring with controlled catalog callbacks: no real CLI/model or user configuration access.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import extension, { inheritParentModel } from '../dist/index.js';
import { tempDir } from './helpers/tmp.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const escape = '\x1b';
function harness(t, piModels = 'provider  model\nfixture  test-model\n') {
  const dir = tempDir('settings-lifecycle'), home = path.join(dir,'home'), cwd = path.join(dir,'project');
  fs.mkdirSync(home); fs.mkdirSync(path.join(cwd,'.pi'),{recursive:true});
  const files = [path.join(home,'cli-subagents.roles.json'),path.join(cwd,'.pi','cli-subagents.roles.json')];
  for (const file of files) fs.writeFileSync(file,'{}\n');
  const oldHome = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = home;
  const probes = [], events = new Map(), commands = new Map(), listeners = [], widgets = [], notices = [], confirms = [], openings = [];
  const exec = t.mock.method(childProcess,'execFile',(_command,args,_options,callback)=>{
    probes.push(()=>callback(null,args.includes('--list-models') ? piModels : '{"models":[]}'));
    return {stdin:{end(){}}};
  });
  syncBuiltinESMExports();
  const ctx = {cwd,mode:'tui',isProjectTrusted:()=>true,sessionManager:{getSessionFile:()=>undefined,getEntries:()=>[]},
    ui:{theme:{fg:(_,text)=>text,bold:text=>text,getThinkingBorderColor:()=>text=>text},
      notify:(...args)=>notices.push(args),
      confirm:async(...args)=>{confirms.push(args);return true;},
      onTerminalInput(listener){listeners.push(listener);return()=>listeners.splice(listeners.indexOf(listener),1);},
      setWidget(key,content){
        const widget = {key,content,renders:0}; widgets.push(widget);
        if (content) widget.component = content({terminal:{rows:36},requestRender(){widget.renders++;}});
      },
    }};
  extension({on:(name,handler)=>events.set(name,handler),registerCommand:(name,command)=>commands.set(name,command),registerTool(){},registerShortcut(){},registerMessageRenderer(){}});
  const h = {ctx,events,listeners,widgets,notices,confirms,files,
    open(){
      const before = widgets.length, opening = {finished:false};
      opening.running = commands.get('cli-agents-setting').handler('',ctx).then(()=>{opening.finished=true;});
      openings.push(opening);
      assert.equal(widgets.length,before+1,'another panel must not leave role settings permanently busy');
      opening.widget = widgets.at(-1);
      return opening;
    },
    press(key){assert.deepEqual(listeners.at(-1)(key),{consume:true});},
    async finishProbes(){for(const complete of probes.splice(0)) complete();await turn();},
  };
  t.after(async()=>{
    events.get('session_shutdown')();
    // Also release the intentionally broken pre-fix implementation when a red assertion fails.
    for(const listener of [...listeners]) for(let i=0;i<3;i++) listener(escape);
    await Promise.all(openings.map(opening=>opening.running));
    await h.finishProbes();
    exec.mock.restore(); syncBuiltinESMExports();
    if(oldHome === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldHome;
    fs.rmSync(dir,{recursive:true,force:true});
  });
  return h;
}

test('shutdown settles role settings in list, picker and rebuilt dirty views without saving or confirming', {timeout:5000}, async t => {
  const h = harness(t);
  for(const enters of [0,2,3]) {
    const opening = h.open();
    for(let i=0;i<enters;i++) h.press('\r');
    await turn();
    if(enters === 2) assert.match(opening.widget.component.render(120).join('\n'),/· cli/);
    if(enters === 3) assert.match(opening.widget.component.render(120).join('\n'),/unsaved/);
    const staleInput = h.listeners.at(-1);
    h.events.get('session_shutdown')(); h.events.get('session_shutdown')();
    await turn();
    assert.equal(opening.finished,true,`shutdown must settle the panel after ${enters} Enter presses`);
    assert.equal(h.listeners.length,0);
    assert.equal(h.widgets.at(-1).key,'cli-subagents-role-settings');
    assert.equal(h.widgets.at(-1).content,undefined);
    assert.deepEqual(opening.widget.component.render(120),[]);
    assert.equal(staleInput('\r'),undefined,'a closed pane must not consume input meant for the editor');
    assert.deepEqual(h.confirms,[],'shutdown must not create an unsaved-change dialog');
    for(const file of h.files) assert.equal(fs.readFileSync(file,'utf8'),'{}\n');
  }
  const before = h.widgets.map(widget=>widget.renders);
  await h.finishProbes();
  assert.deepEqual(h.widgets.map(widget=>widget.renders),before,'late catalog results must not redraw closed panes');
  assert.deepEqual(h.notices,[]);
});

for(const scope of ['project','user']) test(`the ${scope} role pane preserves external edits, keeps the draft dirty and saves after reopen`, {timeout:5000}, async t => {
  const h = harness(t); h.ctx.isProjectTrusted = () => scope === 'project';
  const file = h.files[scope === 'project' ? 1 : 0], untouched = h.files[scope === 'project' ? 0 : 1];
  const opening = h.open();
  for(let i=0;i<3;i++) h.press('\r'); await turn();
  assert.match(opening.widget.component.render(120).join('\n'),/unsaved/);
  const external = JSON.stringify({external:{description:'External legitimate change',instructions:'Retain this role.'}});
  fs.writeFileSync(file,external);
  h.press('s'); await turn();
  assert.equal(fs.readFileSync(file,'utf8'),external,'stale panel save must not overwrite the external role');
  assert.equal(fs.readFileSync(untouched,'utf8'),'{}\n');
  assert(h.notices.some(([message,level])=>level==='error' && /changed on disk.*reopen/i.test(message)));
  assert(!h.notices.some(([message])=>message.startsWith('Saved ')));
  assert.match(opening.widget.component.render(120).join('\n'),/unsaved/,'a conflict must not silently discard the local draft');
  h.press(escape); h.press(escape); await opening.running;
  assert.equal(h.confirms.length,1,'closing the dirty draft still asks before discarding it');
  const reopened = h.open();
  for(let i=0;i<3;i++) h.press('\r'); await turn();
  h.press('s'); await turn();
  const saved = JSON.parse(fs.readFileSync(file,'utf8'));
  assert.deepEqual(saved.external,JSON.parse(external).external);
  assert.equal(saved.explore.cli,'pi');
  assert.doesNotMatch(reopened.widget.component.render(120).join('\n'),/unsaved/);
  // A second save must use the last successful snapshot, not the original open-time document.
  h.press('\r'); h.press('\r'); await turn(); h.press('s'); await turn();
  assert.equal(h.notices.filter(([message])=>message.startsWith('Saved ')).length,2);
  assert.equal(h.notices.filter(([,level])=>level==='error').length,1);
  h.press(escape); h.press(escape); await reopened.running;
  assert.equal(h.confirms.length,1,'success cleared dirty state; normal close does not ask again');
});

test('catalog selection persists provider/model together; later provider edits warn without clearing custom models', {timeout:5000}, async t => {
  const h = harness(t, 'provider  model\na  parent-model\nb  b-only\n');
  h.ctx.model = {provider:'a',id:'parent-model'}; h.ctx.thinkingLevel = 'high';
  h.ctx.ui.input = async () => 'custom-model';
  const opening = h.open(); await h.finishProbes();
  for(const key of ['\r','\x1b[B','\x1b[B','\r','\x1b[B','\r']) h.press(key);
  await turn(); h.press('s'); await turn();
  let saved = JSON.parse(fs.readFileSync(h.files[1],'utf8')).explore;
  assert.equal(saved.provider,'b'); assert.equal(saved.model,'b-only');
  assert.equal(inheritParentModel(saved,h.ctx).provider,'b','parent a must not replace selected provider b');
  assert.equal(inheritParentModel(saved,h.ctx).thinking,'high','unset thinking still inherits independently');
  // Changing just provider must retain model and warn rather than silently clear it.
  for(const key of ['\x1b[A','\r','\x1b[A','\r']) h.press(key);
  await turn(); h.press('s'); await turn();
  saved = JSON.parse(fs.readFileSync(h.files[1],'utf8')).explore;
  assert.equal(saved.provider,'a'); assert.equal(saved.model,'b-only');
  assert(h.notices.some(([message,level])=>level==='warning' && /not listed.*kept/i.test(message)));
  // A typed custom model remains allowed even when absent from discovery.
  for(const key of ['\x1b[B','\r','\x1b[B','\r']) h.press(key);
  await turn(); h.press('s'); await turn();
  saved = JSON.parse(fs.readFileSync(h.files[1],'utf8')).explore;
  assert.equal(saved.provider,'a'); assert.equal(saved.model,'custom-model');
  assert(!h.notices.some(([,level])=>level==='error'));
  h.press(escape); h.press(escape); await opening.running;
});

test('session replacement closes the old settings pane and subsequent normal close and shutdown remain independent', {timeout:5000}, async t => {
  const h = harness(t), old = h.open();
  h.events.get('session_start')({reason:'switch'},h.ctx);
  await turn();
  assert.equal(old.finished,true);
  assert.equal(h.listeners.length,0);
  const next = h.open();
  h.press(escape); await next.running;
  assert.equal(h.listeners.length,0,'normal Escape still disposes its own pane');
  const last = h.open();
  h.events.get('session_shutdown')(); await turn();
  assert.equal(last.finished,true,'a stale callback must not take ownership from a reopened pane');
  assert.equal(h.listeners.length,0); assert.equal(h.widgets.at(-1).content,undefined);
  assert.deepEqual(h.notices,[]);
});
