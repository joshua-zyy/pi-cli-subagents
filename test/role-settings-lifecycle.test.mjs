// Extension wiring with controlled catalog callbacks: no real CLI/model or user configuration access.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
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
  const savedEnv = Object.fromEntries(['PI_CODING_AGENT_DIR','CLAUDE_CONFIG_DIR','CODEX_HOME','ProgramFiles','PATH'].map(key=>[key,process.env[key]]));
  const bin=path.join(dir,'bin');fs.mkdirSync(path.join(bin,'node_modules','@openai','codex','bin'),{recursive:true});
  for(const file of ['claude.exe','claude','codex','node_modules/@openai/codex/bin/codex.js'])fs.writeFileSync(path.join(bin,file),'');
  Object.assign(process.env,{PI_CODING_AGENT_DIR:home,CLAUDE_CONFIG_DIR:home,CODEX_HOME:home,ProgramFiles:path.join(dir,'system'),PATH:bin});
  const probes = [], events = new Map(), commands = new Map(), listeners = [], widgets = [], notices = [], confirms = [], openings = [];
  const exec = t.mock.method(childProcess,'execFile',(_command,args,_options,callback)=>{
    probes.push(output=>callback(null,output ?? (args.includes('--list-models') ? piModels : '{"models":[]}')));
    return {stdin:{end(){}}};
  });
  const config={model:'native-codex',model_reasoning_effort:'xhigh',sandbox_mode:'read-only',approval_policy:'on-request'};
  const spawn=t.mock.method(childProcess,'spawn',(_command,args)=>{
    assert.equal(args.at(-1),'app-server','settings must not start a model turn or another executable');
    const child=new EventEmitter();child.stdout=new PassThrough();child.stdin=new EventEmitter();
    child.stdin.write=s=>{const m=JSON.parse(s);if(m.id)probes.push(()=>child.stdout.write(JSON.stringify({id:m.id,result:m.id===1?{}:{config}})+'\n'));};
    child.stdin.end=()=>child.emit('close',0);return child;
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
  const h = {ctx,events,listeners,widgets,notices,confirms,files,home,config,probes,
    open(){
      const before = widgets.length, opening = {finished:false};
      opening.running = commands.get('cli-agents-setting').handler('',ctx).then(()=>{opening.finished=true;});
      openings.push(opening);
      assert.equal(widgets.length,before+1,'another panel must not leave role settings permanently busy');
      opening.widget = widgets.at(-1);
      return opening;
    },
    press(key){assert.deepEqual(listeners.at(-1)(key),{consume:true});},
    async finishProbes(){while(probes.length)for(const complete of probes.splice(0)) complete();await turn();},
  };
  t.after(async()=>{
    events.get('session_shutdown')();
    // Also release the intentionally broken pre-fix implementation when a red assertion fails.
    for(const listener of [...listeners]) for(let i=0;i<3;i++) listener(escape);
    await Promise.all(openings.map(opening=>opening.running));
    await h.finishProbes();
    exec.mock.restore(); spawn.mock.restore(); syncBuiltinESMExports();
    for(const [key,value]of Object.entries(savedEnv))if(value===undefined)delete process.env[key];else process.env[key]=value;
    fs.rmSync(dir,{recursive:true,force:true});
  });
  return h;
}

test('a late previous-session catalog cannot replace the current model picker', {timeout:5000}, async t => {
  const h = harness(t);
  let parent = path.join(h.home, 'first-session.jsonl');
  fs.writeFileSync(parent, '{}\n');
  h.ctx.sessionManager.getSessionFile = () => parent;
  h.events.get('session_start')({}, h.ctx);
  const previous = h.probes.splice(0);
  parent = path.join(h.home, 'second-session.jsonl'); fs.writeFileSync(parent, '{}\n');
  h.events.get('session_start')({}, h.ctx);
  const current = h.probes.splice(0);
  assert.equal(previous.length, 2); assert.equal(current.length, 2);
  current[0]('provider  model\nnew-provider  new-model\n'); current[1](); await turn();
  const opening = h.open(); await h.finishProbes();
  for (const key of ['\r', '\x1b[B', '\x1b[B', '\r']) h.press(key);
  const render = () => opening.widget.component.render(180).join('\n');
  assert.match(render(), /new-provider\/new-model/, 'the current probe still populates the picker');
  const renders = opening.widget.renders;
  previous[0]('provider  model\nold-provider  old-model\n'); previous[1](); await turn();
  assert.match(render(), /new-provider\/new-model/);
  assert.doesNotMatch(render(), /old-provider|old-model/);
  assert.equal(opening.widget.renders, renders, 'an old probe must not repaint the current pane');
  h.press(escape); h.press(escape); h.press(escape); await opening.running;
});

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

test('a constructor role inherited from personal scope edits the right baseline in project scope', {timeout:5000}, async t => {
  const h = harness(t), source = {description:'Personal constructor',instructions:'Keep these instructions',cli:'pi'};
  fs.writeFileSync(h.files[0],JSON.stringify({constructor:source}));
  const editors = []; h.ctx.ui.editor = async (_title,value) => {editors.push(value);return 'Project constructor';};
  const opening = h.open();
  assert.match(opening.widget.component.render(160).join('\n'),/constructor.*personal/);
  for(let i=0;i<4;i++) h.press('\x1b[B'); h.press('\r');
  for(let i=0;i<4;i++) h.press('\x1b[B'); h.press('\r'); await turn();
  assert.deepEqual(editors,['Personal constructor']);
  h.press('s'); await turn();
  assert.deepEqual(JSON.parse(fs.readFileSync(h.files[1],'utf8')).constructor,{...source,description:'Project constructor'});
  assert.deepEqual(JSON.parse(fs.readFileSync(h.files[0],'utf8')).constructor,source);
  assert(!h.notices.some(([,level])=>level==='error'));
  h.press(escape); h.press(escape); await opening.running;
});

test('the settings command can add a constructor role without a prototype collision', {timeout:5000}, async t => {
  const h = harness(t); h.ctx.ui.input = async () => 'constructor';
  const opening = h.open(); h.press('a'); await turn();
  assert.match(opening.widget.component.render(120).join('\n'),/constructor.*unsaved/);
  h.press('s'); await turn();
  const saved = JSON.parse(fs.readFileSync(h.files[1],'utf8'));
  assert.equal(Object.hasOwn(saved,'constructor'),true);
  assert.equal(saved.constructor.description,'constructor role');
  assert(!h.notices.some(([message])=>/already exists/.test(message)));
  h.press(escape); h.press(escape); await opening.running;
});

test('switching reviewer backends fills live defaults without saving a snapshot or altering native settings', {timeout:5000}, async t => {
  const h=harness(t);h.ctx.model={provider:'parent-provider',id:'parent-model'};h.ctx.thinkingLevel='high';
  const file=path.join(h.home,'settings.json'), native=JSON.stringify({model:'sonnet',permissions:{defaultMode:'bypassPermissions'},env:{CLAUDE_CODE_EFFORT_LEVEL:'high'}});
  fs.writeFileSync(file,native);
  const opening=h.open();await h.finishProbes();
  for(const key of ['\x1b[B','\x1b[B','\r','\r','\x1b[B','\x1b[B','\r'])h.press(key);await turn();
  const text=opening.widget.component.render(180).join('\n');
  assert.match(text,/reviewer — project/);assert.match(text,/model\s+sonnet/);assert.match(text,/thinking\s+high/);assert.match(text,/mode\s+bypassPermissions/);
  assert.match(text,/stops asking for approval/);assert.doesNotMatch(text,/native default|parent-model|parent-provider|\(empty\)/);
  h.press('s');await turn();let saved=JSON.parse(fs.readFileSync(h.files[1],'utf8')).reviewer;
  assert.equal(saved.cli,'claude');for(const key of ['model','thinking','mode','effort','provider'])assert.equal(Object.hasOwn(saved,key),false,key);
  assert.equal(fs.readFileSync(file,'utf8'),native);
  // Current CLI is Claude, so moving one row up switches to Codex; defaults change without old Claude fields.
  for(const key of ['\r','\x1b[A','\r'])h.press(key);await turn();
  const codex=opening.widget.component.render(180).join('\n');assert.match(codex,/model\s+native-codex/);assert.match(codex,/effort\s+xhigh/);assert.match(codex,/mode\s+read-only/);assert.doesNotMatch(codex,/sonnet|thinking|bypassPermissions/);
  h.press('s');await turn();saved=JSON.parse(fs.readFileSync(h.files[1],'utf8')).reviewer;
  assert.equal(saved.cli,'codex');assert.equal(Object.hasOwn(saved,'model'),false);assert.equal(Object.hasOwn(saved,'mode'),false);
  h.press(escape);h.press(escape);await opening.running;
});

test('opening the settings pane again reads fresh native defaults without dirtying or saving roles', {timeout:5000}, async t => {
  const h=harness(t), file=path.join(h.home,'settings.json');
  fs.writeFileSync(h.files[1],JSON.stringify({reviewer:{cli:'claude',description:'Reviewer',instructions:'Review only.'}}));
  for(const model of ['first-model','updated-model']) {
    fs.writeFileSync(file,JSON.stringify({model,env:{CLAUDE_CODE_EFFORT_LEVEL:'medium'},permissions:{defaultMode:'manual'}}));
    const opening=h.open();await h.finishProbes();h.press('\x1b[B');h.press('\x1b[B');h.press('\r');
    const text=opening.widget.component.render(160).join('\n');assert.match(text,new RegExp(`model\\s+${model}`));assert.doesNotMatch(text,/unsaved/);
    h.press(escape);h.press(escape);await opening.running;
  }
  assert.deepEqual(h.confirms,[]);assert.equal(JSON.parse(fs.readFileSync(h.files[1],'utf8')).reviewer.model,undefined);
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

test('switching scope returns to the top of the list instead of reopening the edited role', {timeout:5000}, async t => {
  const h = harness(t);
  // The panel lists the merged union of both scopes, so a role defined in both stays listed either way.
  fs.writeFileSync(h.files[0], JSON.stringify({explore:{description:'Personal explore',instructions:'Personal instructions'}}));
  fs.writeFileSync(h.files[1], JSON.stringify({explore:{description:'Project explore',instructions:'Project instructions'}}));
  const editors = []; h.ctx.ui.editor = async (title,value) => {editors.push({title,value});return 'Edited description';};
  const opening = h.open(), rendered = () => opening.widget.component.render(160).join('\n');
  h.press('\r'); await turn();                                   // open the first role
  assert.match(rendered(), /explore — project/);
  h.press('\x1b[B'); h.press('\r'); await turn();                // its description field
  assert.deepEqual(editors.map(entry => entry.title), ['Description for explore']);
  assert.match(rendered(), /explore — project • unsaved/, 'a kept cursor reopens the edited role and field');
  h.press('\x1b'); await turn();                                 // back to the list; Tab is only wired there
  h.press('\t'); await turn();                                   // switch to the personal scope
  assert.match(rendered(), /Subagent roles — personal/, 'a scope switch must start the other scope from the top of the list');
  assert.doesNotMatch(rendered(), /explore — /, 'the cursor must not carry the edited role into the other scope');
  h.press('\x1b'); await turn();                                 // the dirty draft asks before it is discarded
  await opening.running;
  assert.equal(h.confirms.length, 1);
  assert.equal(h.listeners.length, 0);
});
