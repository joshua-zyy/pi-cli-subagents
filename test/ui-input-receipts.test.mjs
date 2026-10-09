// Exercise extension UI entry points with controlled manager results, not CLI/model processes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import extension from '../dist/index.js';
import { AgentManager } from '../dist/manager.js';
import { WorkspaceDecisionRequired } from '../dist/workspace.js';
import { waitUntil } from '../dist/storage.js';

const theme = {fg:(_,text)=>text, bg:(_,text)=>text, bold:text=>text, getThinkingBorderColor:()=>text=>text};
function harness(t, beforePhase = 'completed', decision = 'none') {
  const before = {id:randomUUID(), runId:randomUUID(), cli:'pi', role:'worker', phase:beforePhase, questions:[], cwd:process.cwd(), updatedAt:1, logFile:'fixture'};
  const failed = {...before, runId:beforePhase === 'running' ? before.runId : randomUUID(), phase:'failed', accepted:beforePhase === 'running', error:'fixture native identity mismatch'};
  const notices = [], messages = [], calls = [], commands = new Map(), events = new Map();
  const ws = {id:randomUUID(), revision:3};
  const mocks = [
    t.mock.method(AgentManager.prototype, 'list', () => [before]),
    t.mock.method(AgentManager.prototype, 'get', id => {assert.equal(id,before.id);return before;}),
    t.mock.method(AgentManager.prototype, 'eventLogs', () => []),
    t.mock.method(AgentManager.prototype, 'spawn', () => {throw Error('UI must not create a replacement instance');}),
    t.mock.method(AgentManager.prototype, 'send', async (id, message, mode, options) => {
      calls.push({id,message,mode,options});
      if (decision !== 'none' && calls.length === 1) throw new WorkspaceDecisionRequired('baseline', ws, 'Choose a baseline');
      if (decision === 'inherit' && calls.length === 2) throw new WorkspaceDecisionRequired('inherit', ws, 'Confirm parent changes', ['file.txt'], 'fixture-tree');
      return failed;
    }),
  ];
  let listener, viewer, running;
  const ctx = {cwd:process.cwd(), mode:'tui', isProjectTrusted:()=>false,
    sessionManager:{getSessionFile:()=>'/fixture/ui-parent.jsonl',getEntries:()=>[]},
    ui:{theme, notify:(message,type)=>notices.push({message,type}), setWidget(){},
      onTerminalInput(fn){listener=fn;return()=>{listener=undefined;};},
      editor:async()=> 'FOLLOW_UP', select:async()=> 'sync — update workspace from parent', confirm:async()=>true,
      custom(factory){return new Promise(resolve=>{viewer=factory({terminal:{rows:35,columns:400},requestRender(){}},theme,{},resolve);});},
    }};
  extension({on:(name,handler)=>events.set(name,handler), registerTool(){}, registerCommand:(name,command)=>commands.set(name,command), registerShortcut(){}, registerMessageRenderer(){},
    sendMessage:(message,options)=>messages.push({message,options})});
  return {before,failed,notices,messages,calls,ctx,commands,
    open(){running=commands.get('agents').handler('',ctx);},
    press(key){assert.deepEqual(listener(key),{consume:true});},
    viewer:()=>viewer,
    async close(){events.get('session_shutdown')();await running;for(const mock of mocks)mock.mock.restore();},
  };
}
function assertFailureEvidence(h, text) {
  assert.match(text, /failed/i);
  for (const value of [h.failed.id,h.failed.runId,h.failed.error]) assert.ok(text.includes(value), `missing evidence: ${value}`);
  assert.match(text, /Inspect.*retry/i);
  assert.doesNotMatch(text, /(?:New turn|Turn|Message|Instructions) accepted/);
  const human = h.messages.filter(entry=>entry.message.customType === 'cli-subagents-human-action');
  assert.equal(human.length,1,'failed human input is still recorded for the parent');
  assert.match(human[0].message.content,/Input request failed/);
  for(const value of [h.failed.id,h.failed.runId,h.failed.error,'FOLLOW_UP']) assert.ok(human[0].message.content.includes(value));
  assert.equal(human[0].options.triggerTurn,false);
  assert.equal(human[0].message.details.ids,undefined,'an attempted input is not a completion receipt');
}

test('roster reports failed input with original evidence after direct or confirmed workspace continuation', async t => {
  for(const [phase,decision] of [['completed','none'],['running','none'],['completed','baseline'],['completed','inherit']]) {
    const h = harness(t,phase,decision);
    try {
      h.open(); h.press('i'); h.press('s');
      await waitUntil('roster receipt',()=>h.messages.length>0,2000);
      const errors = h.notices.filter(notice=>notice.type === 'error');
      assert.equal(errors.length,1,'resolved failed state must be surfaced as a UI error');
      assertFailureEvidence(h,errors[0].message);
      if (decision !== 'none') assert.match(h.messages[0].message.content,/workspace baseline: sync/,'the failure record retains the chosen baseline');
      assert.ok(!h.notices.some(notice=>/accepted/i.test(notice.message)));
      assert.equal(h.calls.length,decision === 'inherit' ? 3 : decision === 'baseline' ? 2 : 1,'no automatic retry after failure');
    } finally {await h.close();}
  }
});

test('human task answers collect custom text locally and submit one logical reply', async t => {
  for(const value of ['Human task context',undefined]){
    const h=harness(t,'waiting'),replies=[];
    h.before.questions=[{id:'logical-question',kind:'question',method:'select',title:'Choose tests',
      message:'Unit — Fast tests',options:['Unit','Integration'],humanOnly:false,parentPolicy:{values:['Unit','Integration'],text:true}}];
    const reply=t.mock.method(AgentManager.prototype,'reply',async(id,questionId,answer)=>{
      replies.push({id,questionId,answer});return h.before;
    });
    try {
      h.ctx.hasUI=true;
      h.ctx.ui.select=async(title,options)=>{assert.match(title,/Fast tests/);assert.deepEqual(options,['Unit','Integration','Type something.']);return 'Type something.';};
      h.ctx.ui.input=async()=>value;
      await h.commands.get('agent-reply').handler(h.before.id+' logical-question',h.ctx);
      assert.deepEqual(replies,[{id:h.before.id,questionId:'logical-question',answer:value===undefined?{cancelled:true}:{value}}]);
      assert(h.notices.some(n=>n.type==='info'&&/response accepted/.test(n.message)));
      assert.equal(h.messages.filter(m=>m.message.customType==='cli-subagents-human-action').length,1);
    } finally {reply.mock.restore();await h.close();}
  }
});

test('human Codex forms collect fields once, warn about visible sensitive input, and cancel atomically', async t => {
  for (const [value, custom] of [['literal context', false], ['custom context', true], [undefined, false], [undefined, true]]) {
    const h = harness(t, 'waiting'), replies = [];
    h.before.questions = [{ id: 'native-form', method: 'form', kind: 'question', parentPolicy: { answers: true }, fields: [
      { id: 'checks', header: 'Tests', question: 'Which checks?', options: [{ label: 'Unit', description: 'Focused checks' }], allowOther: custom, isSecret: false },
      { id: 'context', header: 'Context', question: 'Supply context', options: [], allowOther: true, isSecret: true },
    ] }];
    const reply = t.mock.method(AgentManager.prototype, 'reply', async (id, questionId, answer) => {
      replies.push({ id, questionId, answer }); return h.before;
    });
    try {
      h.ctx.hasUI = true;
      h.ctx.ui.select = async (title, options) => {
        assert.match(title, /Which checks/); assert.match(options[0], /Unit.*Focused checks/);
        if (custom) { assert.match(options.at(-1), /Type something/); return options.at(-1); }
        assert.equal(options.length, 1); return options[0];
      };
      h.ctx.ui.input = async title => {
        if (custom && title.includes('Which checks')) return value === undefined ? undefined : 'Custom checks';
        assert.match(title, /sensitive|secret/i); assert.match(title, /visible|not masked/i); return value;
      };
      await h.commands.get('agent-reply').handler(h.before.id + ' native-form', h.ctx);
      assert.deepEqual(replies, [{ id: h.before.id, questionId: 'native-form', answer: value === undefined ? { cancelled: true } : { answers: { checks: [custom ? 'Custom checks' : 'Unit'], context: [value] } } }]);
      const action = h.messages.find(m => m.message.customType === 'cli-subagents-human-action'); assert(action);
      if (value) assert(!action.message.content.includes(value), 'the human-action summary need not repeat answer contents');
    } finally { reply.mock.restore(); await h.close(); }
  }
});

test('human multi-select forms toggle choices, preserve previews, allow explicit skips and cancel without partial replies', async t => {
  for(const scenario of [
    {steps:[0,0,1,'custom','done'],inputs:['custom, exact','context'],answer:{answers:{outputs:['Summary','custom, exact'],context:['context']}}},
    {steps:['done'],inputs:['context'],answer:{answers:{outputs:[],context:['context']}}},
    {steps:[1,'custom','done'],inputs:['','context'],answer:{answers:{outputs:['Summary'],context:['context']}}},
    {steps:[0,'done'],inputs:[undefined],answer:{cancelled:true}},
    {steps:['custom'],inputs:[undefined],answer:{cancelled:true}},
  ]) {
    const h=harness(t,'waiting'),replies=[],steps=[...scenario.steps],inputs=[...scenario.inputs];
    h.before.questions=[{id:'claude-form',title:'Native task questions',method:'form',kind:'question',humanOnly:true,parentPolicy:{},fields:[
      {id:'outputs',header:'Outputs',question:'Which outputs?',description:'Select the authorized evidence',multiSelect:true,allowOther:true,isSecret:false,options:[
        {label:'Finish selection.',description:'An ordinary label',preview:'<pre>raw preview</pre>'},{label:'Summary',description:'Short report'},
      ]},
      {id:'context',header:'Context',question:'Supply context',description:'Literal input only',multiSelect:false,allowOther:true,isSecret:false,options:[]},
    ]}];
    const reply=t.mock.method(AgentManager.prototype,'reply',async(id,questionId,answer)=>{replies.push({id,questionId,answer});return h.before;});
    try {
      h.ctx.hasUI=true;
      h.ctx.ui.select=async(title,options)=>{
        assert.match(title,/human/i);assert.match(title,/authorized evidence/);assert.match(title,/raw preview/);
        assert.match(options[0],/1\..*\[[ x]\].*Finish selection/);
        const step=steps.shift();assert.notEqual(step,undefined,'UI must not reopen a completed form');
        if(typeof step==='number') return options[step];
        if(step==='custom') return options.find(value=>/Type something|Edit other/i.test(value));
        return options.find(value=>/^\d+\. Finish selection\./.test(value));
      };
      h.ctx.ui.input=async()=>{assert(inputs.length);return inputs.shift();};
      await h.commands.get('agent-reply').handler(h.before.id+' claude-form',h.ctx);
      assert.deepEqual(replies,[{id:h.before.id,questionId:'claude-form',answer:scenario.answer}]);
      assert.equal(steps.length,0);assert.equal(inputs.length,0);
    } finally {reply.mock.restore();await h.close();}
  }
});

test('human form display escapes controls while preserving native field IDs and selected labels', async t => {
  const h=harness(t,'waiting'),replies=[],displays=[],poison='\u202e\u2069\u2028\u2029\u061c\u200f\x1b[31m';
  h.before.questions=[{id:'untrusted-form',title:'Title'+poison,method:'form',kind:'question',humanOnly:true,parentPolicy:{},fields:[false,true].map((multiSelect,index)=>({
    id:String(index)+poison,header:'Header'+poison,question:'Question'+poison,description:'Hint'+poison,multiSelect,allowOther:true,isSecret:false,
    options:[{label:'First'+poison,description:'Description'+poison,preview:'<pre>'+poison+'</pre>'},{label:'Second',description:'Plain'}],
  }))}];
  const snapshot=structuredClone(h.before.questions),fields=h.before.questions[0].fields;
  const reply=t.mock.method(AgentManager.prototype,'reply',async(_id,_questionId,answer)=>{replies.push(answer);return h.before;});
  try {
    h.ctx.hasUI=true;let menus=0;
    h.ctx.ui.select=async(title,options)=>{
      displays.push({title,options});
      return ++menus===3?options.at(-1):options[0];
    };
    await h.commands.get('agent-reply').handler(h.before.id+' untrusted-form',h.ctx);
    assert.equal(menus,3);
    for(const {title,options} of displays) {
      for(const text of [title,...options]) assert.doesNotMatch(text,/[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e-\u200f\u2028-\u202e\u2066-\u2069]/u);
      assert.match(title,/\\u202e/);assert.match(title,/Human response required/);
    }
    assert.deepEqual(replies,[{answers:Object.fromEntries(fields.map(field=>[field.id,[field.options[0].label]]))}]);
    assert.deepEqual(h.before.questions,snapshot,'presentation must not mutate the native payload');
  } finally {reply.mock.restore();await h.close();}
});

test('inline input surfaces failed state instead of an accepted notice and records the human attempt', async t => {
  for(const phase of ['completed','running']) {
    const h = harness(t,phase);
    try {
      h.open(); h.press('\r');
      const viewer = await waitUntil('viewer',()=>h.viewer(),2000);
      await waitUntil('viewer ready',()=>viewer.render(400).join('\n').includes('worker'),2000);
      viewer.handleInput('\r'); viewer.handleInput('FOLLOW_UP'); viewer.handleInput('\r');
      await waitUntil('inline receipt',()=>/Send failed:|accepted/i.test(viewer.render(400).join('\n')),2000);
      assertFailureEvidence(h,viewer.render(400).join('\n'));
      assert.equal(h.calls.length,1,'failed input must not be replayed');
    } finally {await h.close();}
  }
});
