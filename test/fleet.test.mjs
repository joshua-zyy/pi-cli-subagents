import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import { FleetView } from '../dist/ui/fleet.js';

const theme={fg:(_,s)=>s,bold:s=>s};
const agent=(id,over={})=>({id,role:'worker',task:`Task ${id}`,phase:'running',startedAt:1000,updatedAt:1000,questions:[],...over});
// A Pi installed globally bundles its own pi-tui copy, so focus detection must not rely on `instanceof`.
const promptEditor={getText:()=>'',getExpandedText:()=>'',setText(){}};
const dialog={select:()=>{},render:()=>[]};
function harness(paint=theme) {
  const state={agents:[],text:'',focused:null,actions:[],renders:0,calls:[],handler:null,busy:false};
  const tui={terminal:{columns:80,rows:24},getFocusedComponent:()=>state.focused,requestRender(){state.renders++}};
  state.focused=promptEditor;
  const host={getEditorText:()=>state.text,onTerminalInput(fn){state.handler=fn;return()=>{state.handler=null}},setWidget(key,component,options){state.calls.push({key,component,options});if(component)state.widget=component(tui,paint)}};
  const fleet=new FleetView(host,()=>state.agents,id=>state.actions.push(id),()=>state.busy);
  return {state,fleet,tui,input:s=>state.handler?.(s),render:(width=80)=>state.widget?.render(width).join('\n')};
}

test('no agents means no widget; below-editor roster is navigable without hijacking typed text or modal keys',()=>{
  const h=harness();h.fleet.update();assert.equal(h.state.calls.length,0);
  h.state.agents=[agent('first'),agent('second',{startedAt:2000})];h.fleet.update();
  assert.equal(h.state.calls.at(-1).options.placement,'belowEditor');
  assert.match(h.render(),/○ main/);assert.match(h.render(),/Task first/);
  h.state.text='draft';assert.equal(h.input('\x1b[B'),undefined);
  h.state.text='';h.state.focused=dialog;assert.equal(h.input('\x1b[B'),undefined,'a modal must retain Down');
  h.state.focused=promptEditor;
  assert.deepEqual(h.input('\x1b[B'),{consume:true});
  assert.match(h.render(),/● main/);
  assert.deepEqual(h.input('\x1b[B'),{consume:true});assert.match(h.render(),/^\s*● worker.*Task first/m);
  assert.deepEqual(h.input('\x1b[B'),{consume:true});assert.match(h.render(),/^\s*● worker.*Task second/m);
  assert.deepEqual(h.input('\r'),{consume:true});assert.deepEqual(h.state.actions,['second']);
  assert.equal(h.input('\x1b[B'),undefined,'overlay must own its input');
  h.fleet.viewerClosed();assert.deepEqual(h.input('\x1b'),{consume:true});
  assert.equal(h.input('x'),undefined);assert.equal(h.state.actions.length,1);
  h.fleet.dispose();assert.equal(h.state.handler,null);assert.equal(h.state.calls.at(-1).component,undefined);
});

test('narrow rosters keep same-role instances apart by identity',()=>{
  const h=harness();const now=Date.now();
  h.state.agents=[agent('3f2a9c1b-1111-4111-8111-111111111111',{startedAt:now-12000,updatedAt:now,task:'Add multiplication to the calculator module'}),
    agent('b7e4d2a0-2222-4222-8222-222222222222',{startedAt:now-9000,updatedAt:now,task:'Add addition to the calculator module'})];
  h.fleet.update();
  const rows=h.state.widget.render(40);
  assert.match(rows[2],/worker 3f2a9c1b/);assert.match(rows[3],/worker b7e4d2a0/);
  assert.notEqual(rows[2],rows[3],'identical roles must not render identical rows');
  assert.ok(rows.every(row=>visibleWidth(row)<=40));
});

test('Kitty release keys do not move selection; finished children linger, widths clamp and selection survives updates',()=>{
  const h=harness();h.state.agents=[agent('a'),agent('b',{startedAt:2000})];h.fleet.update();
  h.input('\x1b[B');h.input('\x1b[B');
  h.input('\x1b[1;1:3B');assert.match(h.render(),/^\s*● worker.*Task a/m);
  h.state.agents=[agent('a'),agent('b',{startedAt:2000,phase:'completed',updatedAt:Date.now()})];h.fleet.update();
  assert.match(h.render(),/Task b/);
  assert.ok(h.state.widget.render(25).every(row=>visibleWidth(row)<=25));
  h.state.agents=[agent('a')];h.fleet.update();assert.match(h.render(),/main/);
  h.fleet.dispose();
});

test('idle resources outlive fleet linger and remain selectable',()=>{
  const h=harness(); h.state.agents=[agent('idle',{phase:'idle',lastStatus:'failed',error:'native failure',updatedAt:1})];
  h.fleet.update(); assert.match(h.render(),/Task idle/); assert.match(h.render(),/Idle.*Failed/);
  h.input('\x1b[B'); h.input('\x1b[B'); h.input('\r'); assert.deepEqual(h.state.actions,['idle']);
  h.fleet.dispose();
});

test('six children remain visible after selecting and viewing the last on a normal terminal',()=>{
  const h=harness(),now=Date.now();
  h.state.agents=Array.from({length:6},(_,i)=>agent(`child${i}`,{startedAt:now+i,updatedAt:now}));h.fleet.update();
  h.input('\x1b[B');
  for(let i=0;i<6;i++)h.input('\x1b[B');
  h.input('\r');h.fleet.viewerClosed();
  for(let i=0;i<6;i++)assert.ok(h.render().includes(`Task child${i}`),`child${i} disappeared despite available terminal height`);
  assert.match(h.render(),/^\s*● worker.*Task child5/m);
  for(let i=0;i<6;i++)h.input('\x1b[A');
  assert.match(h.render(),/● main/);assert.match(h.render(),/Task child0/);
  h.fleet.dispose();
});

test('height-bounded rosters keep main and the selected child visible through resize and scrolling',()=>{
  const h=harness(),now=Date.now();
  h.state.agents=Array.from({length:15},(_,i)=>agent(`child${i}`,{startedAt:now+i,updatedAt:now}));h.fleet.update();
  h.input('\x1b[B');for(let i=0;i<15;i++)h.input('\x1b[B');
  for(const rows of [6,12,24]){
    h.tui.terminal.rows=rows;
    const lines=h.state.widget.render(80),body=lines.join('\n');
    assert.ok(lines.length<=Math.floor(rows/2),'the roster must leave room for the prompt and history');
    assert.match(body,/○ main/);assert.match(body,/^\s*● worker.*Task child14/m);assert.match(body,/↑ \d+ more/);
  }
  for(let i=0;i<15;i++)h.input('\x1b[A');
  assert.match(h.render(),/● main/);assert.match(h.render(),/Task child0/);assert.match(h.render(),/↓ \d+ more/);
  h.fleet.dispose();
});

test('a single selection column retains warning and failure labels with semantic colors',()=>{
  const paints=[],h=harness({...theme,fg:(color,text)=>{paints.push({color,text});return text}});
  h.state.agents=[agent('approval',{phase:'waiting'}),agent('failure',{phase:'idle',lastStatus:'failed',error:'native failure'})];h.fleet.update();
  const body=h.render();
  assert.match(body,/^\s*○ worker.*Waiting/m);assert.match(body,/^\s*○ worker.*Idle.*Failed/m);
  assert.ok(paints.some(p=>p.color==='warning'&&p.text==='Waiting'));
  assert.ok(paints.some(p=>p.color==='error'&&p.text==='Idle · last Failed'));
  h.fleet.dispose();
});

test('a pane that owns the keyboard suspends the below-editor roster',()=>{
  const h=harness();
  h.state.agents=[agent('first')];h.fleet.update();
  assert.deepEqual(h.input('\x1b[B'),{consume:true});
  assert.match(h.render(),/● main/);
  h.state.busy=true;
  assert.equal(h.input('\x1b[B'),undefined,'a pane with the keyboard keeps the arrow keys');
  assert.match(h.render(),/○ main/,'the roster steps back to its idle hint');
  assert.deepEqual(h.input('\r'),undefined,'Enter must reach the pane, not open an agent');
  h.state.busy=false;
  assert.deepEqual(h.input('\x1b[B'),{consume:true},'the roster resumes once the pane closes');
});
