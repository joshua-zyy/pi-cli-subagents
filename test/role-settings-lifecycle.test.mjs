// Extension wiring with controlled catalog callbacks: no real CLI/model or user configuration access.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import extension from '../dist/index.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
const escape = '\x1b';
function harness(t) {
  const root = path.resolve('.test-output'); fs.mkdirSync(root,{recursive:true});
  const dir = fs.mkdtempSync(path.join(root,'settings-lifecycle-')), home = path.join(dir,'home'), cwd = path.join(dir,'project');
  fs.mkdirSync(home); fs.mkdirSync(path.join(cwd,'.pi'),{recursive:true});
  const files = [path.join(home,'cli-subagents.roles.json'),path.join(cwd,'.pi','cli-subagents.roles.json')];
  for (const file of files) fs.writeFileSync(file,'{}\n');
  const oldHome = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = home;
  const probes = [], events = new Map(), commands = new Map(), listeners = [], widgets = [], notices = [], confirms = [], openings = [];
  const exec = t.mock.method(childProcess,'execFile',(_command,args,_options,callback)=>{
    probes.push(()=>callback(null,args.includes('--list-models') ? 'provider  model\nfixture  test-model\n' : '{"models":[]}'));
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
