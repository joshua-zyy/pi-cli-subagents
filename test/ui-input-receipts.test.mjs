// Exercise extension UI entry points with controlled manager results, not CLI/model processes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/tmp.mjs';
import extension from '../dist/index.js';
import { AgentManager } from '../dist/manager.js';
import { WorkspaceDecisionRequired } from '../dist/workspace.js';
import { waitUntil } from '../dist/storage.js';

const theme = {fg:(_,text)=>text, bg:(_,text)=>text, bold:text=>text, getThinkingBorderColor:()=>text=>text};
function harness(t, beforePhase = 'completed', decision = 'none') {
  const root = tempDir('ui-input-receipts'), originalParent = path.join(root,'parent.jsonl');
  let parent = originalParent; fs.writeFileSync(parent,'{}\n');
  const oldHome = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(root,'agent-home'); fs.mkdirSync(process.env.PI_CODING_AGENT_DIR);
  const entriesByParent = new Map([[parent,[]]]);
  const before = {protocolVersion:3, id:randomUUID(), runId:randomUUID(), cli:'pi', role:'worker', phase:beforePhase, questions:[], cwd:process.cwd(), updatedAt:1, logFile:'fixture'};
  const instance = path.join(parent+'.subagents',before.id);fs.mkdirSync(instance,{recursive:true});
  fs.writeFileSync(path.join(instance,'spec.json'),JSON.stringify({id:before.id,parentFile:parent}));
  const failed = {...before, runId:beforePhase === 'running' ? before.runId : randomUUID(), phase:'failed', accepted:beforePhase === 'running', error:'fixture native identity mismatch'};
  const notices = [], messages = [], calls = [], commands = new Map(), events = new Map();
  const ws = {id:randomUUID(), revision:3};
  const mocks = [
    t.mock.method(AgentManager.prototype, 'list', () => [before]),
    t.mock.method(AgentManager.prototype, 'reports', () => []),
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
  let listener, viewer, running, ticks = 0;
  const ctx = {cwd:root, mode:'tui', isProjectTrusted:()=>false,isIdle:()=>true,abort(){throw Error('unexpected parent abort');},
    sessionManager:{getSessionFile:()=>parent,getEntries:()=>entriesByParent.get(parent) ?? []},
    ui:{theme, notify:(message,type)=>notices.push({message,type}), setWidget(){}, setStatus(){ticks++;},
      onTerminalInput(fn){listener=fn;return()=>{listener=undefined;};},
      editor:async()=> 'FOLLOW_UP', select:async()=> 'sync — update workspace from parent', confirm:async()=>true,
      custom(factory){return new Promise(resolve=>{viewer=factory({terminal:{rows:35,columns:400},requestRender(){}},theme,{},resolve);});},
    }};
  extension({on:(name,handler)=>events.set(name,handler), registerTool(){}, registerCommand:(name,command)=>commands.set(name,command), registerShortcut(){}, registerMessageRenderer(){},
    sendMessage:(message,options)=>{messages.push({message,options,parent});entriesByParent.get(parent).push({type:'custom_message',customType:message.customType,details:message.details});}});
  return {before,failed,notices,messages,calls,ctx,commands,root,originalParent,events,
    wait:()=>running,ticks:()=>ticks,
    input:key=>listener(key),
    activate(file){parent=file;if(!entriesByParent.has(parent))entriesByParent.set(parent,[]);ctx.mode='rpc';events.get('session_start')({},ctx);ctx.mode='tui';},
    open(){running=commands.get('agents').handler('',ctx);},
    press(key){assert.deepEqual(listener(key),{consume:true});},
    viewer:()=>viewer,
    async close(){events.get('session_shutdown')();await running;for(const mock of mocks)mock.mock.restore();
      if(oldHome===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=oldHome;},
  };
}
function idleBatch(t, count = 3) {
  const h = harness(t, 'idle');
  Object.assign(h.before, { protocolVersion: 3, runtimeId: randomUUID(), accepted: true, lastStatus: 'completed' });
  const targets = [h.before, ...Array.from({ length: count - 1 }, () => ({ ...h.before, id: randomUUID(), runId: randomUUID(), runtimeId: randomUUID() }))];
  for (const target of targets.slice(1)) {
    const dir = path.join(h.originalParent + '.subagents', target.id); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ id: target.id, parentFile: h.originalParent }));
  }
  t.mock.method(AgentManager.prototype, 'list', () => targets);
  const released = target => ({ ...target, phase: 'closed', runtimeClosed: true,
    receipt: { operation: 'stop', status: 'released', runId: target.runId, runtimeId: target.runtimeId } });
  return { h, targets, released };
}

test('uncertain runtime release requires explicit confirmation and preserves captured identity', { timeout: 10000 }, async t => {
  for (const scenario of ['cancel', 'release', 'changed', 'refused']) {
    const h = harness(t, 'unreachable'), calls = [];
    Object.assign(h.before, { protocolVersion: 3, runtimeId: randomUUID(), accepted: true, error: 'Input delivery uncertain' });
    const expected = { runId: h.before.runId, runtimeId: h.before.runtimeId };
    h.ctx.ui.confirm = async (title, message) => {
      assert.match(title, /uncertain/i); assert.match(message, /discard|end.*work/i);
      assert(message.includes(expected.runtimeId));
      if (scenario === 'changed') t.mock.method(AgentManager.prototype, 'get', () => ({ ...h.before, runId: randomUUID() }));
      return scenario !== 'cancel';
    };
    t.mock.method(AgentManager.prototype, 'close', async (id, onlyIdle, captured, preserveAccepted) => {
      calls.push({ id, onlyIdle, captured, preserveAccepted });
      if (scenario === 'changed') throw Error('Captured run no longer matches');
      if (scenario === 'refused') throw Error('Worker ownership is uncertain');
      return { ...h.before, phase: 'closed', runtimeClosed: true, receipt: { operation: 'stop', status: 'released', ...captured } };
    });
    try {
      h.open(); h.press('i'); h.press('x');
      if (scenario === 'cancel') {
        await new Promise(setImmediate); assert.deepEqual(calls, []); assert.deepEqual(h.messages, []);
      } else {
        await waitUntil('uncertain release record', () => h.messages.length === 1, 2000);
        assert.deepEqual(calls, [{ id: h.before.id, onlyIdle: false, captured: expected, preserveAccepted: true }]);
        assert.equal(h.messages[0].message.details.runId, expected.runId);
        assert.equal(h.messages[0].options.triggerTurn, false);
        assert.match(h.messages[0].message.content, scenario === 'release' ? /Native processes released/ : /unconfirmed.*Inspect/s);
      }
    } finally { await h.close(); }
  }
});

test('idle batch cancellation performs no release and writes no action record', { timeout: 5000 }, async t => {
  const { h } = idleBatch(t); let confirms = 0, calls = 0;
  h.ctx.ui.confirm = async () => { confirms++; return false; };
  t.mock.method(AgentManager.prototype, 'close', async () => { calls++; });
  try {
    h.open(); h.press('c'); await new Promise(setImmediate);
    assert.equal(confirms, 1); assert.equal(calls, 0); assert.equal(h.messages.length, 0);
  } finally { await h.close(); }
});

test('uncertain release refuses a recovered or replaced snapshot before confirmation', { timeout: 5000 }, async t => {
  for (const changes of [{ phase: 'running' }, { runId: randomUUID() }, { runtimeId: randomUUID() }]) {
    const h = harness(t, 'unreachable'); let confirms = 0, closes = 0;
    Object.assign(h.before, { protocolVersion: 3, runtimeId: randomUUID(), accepted: true });
    t.mock.method(AgentManager.prototype, 'get', () => ({ ...h.before, ...changes }));
    t.mock.method(AgentManager.prototype, 'close', async () => { closes++; });
    h.ctx.ui.confirm = async () => { confirms++; return true; };
    try {
      h.open(); h.press('i'); h.press('x');
      await waitUntil('stale uncertain refusal', () => h.notices.some(n => /captured uncertain runtime/.test(n.message)), 2000);
      assert.equal(confirms, 0); assert.equal(closes, 0); assert.deepEqual(h.messages, []);
    } finally { await h.close(); }
  }
});

test('idle batch reports partial failure per captured target without retrying successful releases', { timeout: 5000 }, async t => {
  const { h, targets, released } = idleBatch(t), calls = []; let confirmation;
  h.ctx.ui.confirm = async (title, message) => { confirmation = { title, message }; return true; };
  t.mock.method(AgentManager.prototype, 'close', async (id, onlyIdle, expected) => {
    calls.push({ id, onlyIdle, expected }); const target = targets.find(value => value.id === id);
    if (id === targets[0].id) throw Error('fixture target changed before release');
    const result = released(target);
    if (id === targets[2].id) result.receipt.status = 'unconfirmed';
    return result;
  });
  try {
    h.open(); h.press('c'); await waitUntil('three idle action records', () => h.messages.length === 3, 2000);
    assert.match(confirmation.title, /idle/i);
    for (const target of targets) assert(confirmation.message.includes(target.id));
    assert.deepEqual(calls, targets.map(({ id, runId, runtimeId }) => ({ id, onlyIdle: true, expected: { runId, runtimeId } })));
    assert(h.messages.every(entry => entry.options.triggerTurn === false && entry.message.details.ids === undefined));
    assert.deepEqual(h.messages.map(entry => entry.message.details.runId), targets.map(target => target.runId));
    assert.match(h.messages[0].message.content, /fixture target changed/);
    assert.match(h.messages[1].message.content, /Native processes released/);
    assert.match(h.messages[2].message.content, /unconfirmed/i);
    const summary = h.notices.find(notice => targets.every(target => notice.message.includes(target.id)));
    assert(summary); assert.equal(summary.type, 'warning');
  } finally { await h.close(); }
});

test('single release rejects a busy or replaced snapshot before asking for confirmation', {timeout:5000}, async t=>{
  for(const changes of [{phase:'running'},{runId:randomUUID()},{runtimeId:randomUUID()}]){
    const {h}=idleBatch(t,1);let confirms=0,closes=0;
    t.mock.method(AgentManager.prototype,'get',()=>({...h.before,...changes}));
    t.mock.method(AgentManager.prototype,'close',async()=>{closes++;throw Error('must not close a replaced snapshot');});
    h.ctx.ui.confirm=async()=>{confirms++;return true;};
    try{
      h.open();h.press('i');h.press('x');await waitUntil('fresh-state refusal',()=>h.notices.some(n=>/captured idle runtime/.test(n.message)),2000);
      assert.equal(confirms,0);assert.equal(closes,0);assert.equal(h.messages.length,0);
    }finally{await h.close();}
  }
});

test('single idle release carries captured identity through confirmation and keeps refusal evidence on the old run', {timeout:5000}, async t => {
  const {h,targets}=idleBatch(t,1),target=targets[0],calls=[],captured={...target};
  h.ctx.ui.confirm=async title=>{assert.match(title,/Release idle/);return true;};
  t.mock.method(AgentManager.prototype,'close',async(id,onlyIdle,expected)=>{
    calls.push({id,onlyIdle,expected});throw Error('captured runtime became busy during confirmation');
  });
  try{
    h.open();h.press('i');h.press('x');await waitUntil('single refused release',()=>h.messages.length===1,2000);
    assert.deepEqual(calls,[{id:target.id,onlyIdle:true,expected:{runId:captured.runId,runtimeId:captured.runtimeId}}]);
    assert.equal(h.messages[0].message.details.runId,captured.runId);
    assert.match(h.messages[0].message.content,/unconfirmed.*became busy/s);assert.equal(h.messages[0].options.triggerTurn,false);
    assert.equal(target.phase,'idle');
  }finally{await h.close();}
});

test('successful batch release shows a concise count while preserving full passive action receipts', {timeout:5000}, async t=>{
  const {h,targets,released}=idleBatch(t,2),calls=[];
  t.mock.method(AgentManager.prototype,'close',async(id,onlyIdle,expected)=>{
    calls.push({id,onlyIdle,expected});return released(targets.find(target=>target.id===id));
  });
  try{
    h.open();h.press('c');await waitUntil('batch records',()=>h.messages.length===2,2000);
    assert.equal(calls.length,2);assert(h.notices.some(notice=>notice.type==='info'&&notice.message==='Released 2 idle subagents.'));
    assert(h.messages.every(entry=>entry.options.triggerTurn===false&&/Native processes released/.test(entry.message.content)));
  }finally{await h.close();}
});

test('parent switch during idle batch stops further releases and retains the in-flight action for its original parent', { timeout: 5000 }, async t => {
  const { h, targets, released } = idleBatch(t, 2), started = Promise.withResolvers(), finish = Promise.withResolvers(), calls = [];
  t.mock.method(AgentManager.prototype, 'close', async id => { calls.push(id); started.resolve(); return finish.promise; });
  try {
    h.open(); h.press('c'); await started.promise;
    h.events.get('session_shutdown')(); h.activate(path.join(h.root, 'other-parent.jsonl'));
    finish.resolve(released(targets[0])); await h.wait();
    assert.deepEqual(calls, [targets[0].id]); assert.equal(h.messages.length, 0);
    const first = path.join(h.originalParent + '.subagents', targets[0].id, 'human-actions');
    assert.equal(fs.readdirSync(first).filter(file => file.endsWith('.json')).length, 1);
    assert.equal(fs.existsSync(path.join(h.originalParent + '.subagents', targets[1].id, 'human-actions')), false);
    h.activate(h.originalParent); await waitUntil('original idle-release record', () => h.messages.length === 1, 2000);
    assert.equal(h.messages[0].parent, h.originalParent); assert.equal(h.messages[0].options.triggerTurn, false);
    assert.deepEqual(calls, [targets[0].id], 'reopening the parent never replays the batch');
  } finally { finish.resolve(released(targets[0])); await h.close(); }
});

test('parent switch while confirming idle batch prevents every release', { timeout: 5000 }, async t => {
  const { h } = idleBatch(t), entered = Promise.withResolvers(), finish = Promise.withResolvers(); let calls = 0;
  h.ctx.ui.confirm = async () => { entered.resolve(); return finish.promise; };
  t.mock.method(AgentManager.prototype, 'close', async () => { calls++; });
  try {
    h.open(); h.press('c'); await entered.promise;
    h.events.get('session_shutdown')(); h.activate(path.join(h.root, 'other-parent.jsonl'));
    finish.resolve(true); await h.wait();
    assert.equal(calls, 0); assert.equal(h.messages.length, 0);
  } finally { finish.resolve(false); await h.close(); }
});

test('an input finishing after a parent switch is durably delivered only when its original parent returns', async t => {
  const h = harness(t), started = Promise.withResolvers(), finished = Promise.withResolvers();
  const sending = t.mock.method(AgentManager.prototype,'send',async()=>{started.resolve();return finished.promise;});
  try {
    h.open();h.press('i');h.press('s');await started.promise;
    h.events.get('session_shutdown')();
    h.activate(path.join(h.root,'other-parent.jsonl'));
    finished.resolve(h.failed);await h.wait();
    assert.equal(h.messages.length,0,'an old request must not write to the new parent');
    const folder = path.join(h.originalParent+'.subagents',h.before.id,'human-actions');
    assert.equal(fs.readdirSync(folder).filter(f=>f.endsWith('.json')).length,1);
    await waitUntil('other parent monitor',()=>h.ticks()>0,2000);assert.equal(h.messages.length,0);
    h.activate(h.originalParent);
    await waitUntil('original parent action',()=>h.messages.length===1,2000);
    assert.equal(h.messages.length,1);assert.equal(h.messages[0].parent,h.originalParent);
    assert.match(h.messages[0].message.content,/FOLLOW_UP/);assert.match(h.messages[0].message.details.actionId,/^ha-/);
    assert.equal(h.messages[0].options.triggerTurn,false);
    const ticks=h.ticks();h.activate(h.originalParent);await waitUntil('reopened parent monitor',()=>h.ticks()>ticks,2000);
    assert.equal(h.messages.length,1,'persisted action receipt survives monitor restart');
  } finally {finished.resolve(h.failed);sending.mock.restore();await h.close();}
});

test('viewer Ctrl+C routes only to the busy parent; roster still yields to Pi', async t => {
  const h = harness(t,'running');let aborts=0,childInterrupts=0;
  h.ctx.isIdle=()=>false;h.ctx.abort=()=>aborts++;
  const interrupt = t.mock.method(AgentManager.prototype,'interrupt',async()=>{childInterrupts++;return h.before;});
  try {
    h.open();assert.equal(h.input('\u0003'),undefined);assert.equal(aborts,0);
    h.press('v');await waitUntil('viewer',()=>h.viewer(),2000);
    h.press('\u0003');assert.equal(aborts,1);assert.equal(childInterrupts,0);
    assert.equal(h.messages.length,0,'parent interruption is not a child action');
  } finally {interrupt.mock.restore();await h.close();}
});

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

test('both human input paths preserve unconfirmed receipts without claiming acceptance', async t => {
  for (const inline of [false,true]) {
    const h = harness(t,'completed');
    Object.assign(h.failed,{phase:'waiting',error:undefined,receipt:{operation:'send',status:'unconfirmed',runId:h.failed.runId}});
    try {
      h.open();
      if(inline){h.press('v');await waitUntil('viewer',()=>h.viewer(),2000);await new Promise(setImmediate);h.viewer().handleInput('\r');h.viewer().handleInput('FOLLOW_UP');h.viewer().handleInput('\r');}
      else {h.press('i');h.press('s');}
      await waitUntil('human receipt',()=>h.messages.length===1,2000);
      assert.match(h.messages[0].message.content,/unconfirmed/i);
      assert.doesNotMatch(h.messages[0].message.content,/(?:Instructions|New turn|Message) accepted/);
      assert(!h.notices.some(n=>/(?:Instructions|New turn|Message) accepted/.test(n.message)));
    } finally {await h.close();}
  }
});

test('human t action interrupts rather than releases and records the actual receipt', async t => {
  const h = harness(t,'running');h.before.protocolVersion=3;
  let calls=0;
  const interrupt = t.mock.method(AgentManager.prototype,'interrupt',async()=>{calls++;return {...h.before,phase:'idle',lastStatus:'stopped',receipt:{operation:'interrupt',status:'settled',runId:h.before.runId}};});
  const close = t.mock.method(AgentManager.prototype,'close',async()=>{throw Error('interrupt must not release');});
  try {
    h.open();h.press('t');await waitUntil('interrupt receipt',()=>h.messages.length===1,2000);
    assert.equal(calls,1);assert.match(h.messages[0].message.content,/captured turn has ended/);
    assert.equal(h.messages[0].options.triggerTurn,false);
  } finally {close.mock.restore();interrupt.mock.restore();await h.close();}
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
      h.ctx.ui.select=async(title,options)=>{assert.match(title,/Fast tests/);assert.deepEqual(options,['1. Unit','2. Integration','3. Type something.']);return options[2];};
      h.ctx.ui.input=async()=>value;
      h.open(); h.press('i'); h.press('r');
      await waitUntil('human answer action', () => h.messages.length === 1, 2000);
      assert.deepEqual(replies,[{id:h.before.id,questionId:'logical-question',answer:value===undefined?{cancelled:true}:{value}}]);
      assert(h.notices.some(n=>n.type==='info'&&/response accepted/.test(n.message)));
      assert.equal(h.messages.filter(m=>m.message.customType==='cli-subagents-human-action').length,1);
    } finally {reply.mock.restore();await h.close();}
  }
});

test('human Codex forms collect fields once, warn about visible sensitive input, and cancel atomically', async t => {
  for (const [value, custom] of [['literal context', false], ['custom context', true], [undefined, false], [undefined, true]]) {
    const h = harness(t, 'running'), replies = [];
    h.before.questions = [{ id: 'native-form', method: 'form', kind: 'question', isBlocking: false, parentPolicy: { answers: true }, fields: [
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
      h.open(); h.press('i'); h.press('r');
      await waitUntil('non-blocking form action', () => h.messages.length === 1, 2000);
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
      h.open(); h.press('i'); h.press('r');
      await waitUntil('multi-select form action', () => h.messages.length === 1, 2000);
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
    h.open(); h.press('i'); h.press('r');
    await waitUntil('escaped form action', () => h.messages.length === 1, 2000);
    assert.equal(menus,3);
    for(const {title,options} of displays) {
      for(const text of [title,...options]) assert.doesNotMatch(text,/[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e-\u200f\u2028-\u202e\u2066-\u2069]/u);
      assert.match(title,/\\u202e/);assert.match(title,/Human response required/);
    }
    assert.deepEqual(replies,[{answers:Object.fromEntries(fields.map(field=>[field.id,[field.options[0].label]]))}]);
    assert.deepEqual(h.before.questions,snapshot,'presentation must not mutate the native payload');
  } finally {reply.mock.restore();await h.close();}
});

test('unchanged editor prefill returns the original native value', async t => {
  for (const prefill of ['Text\x1b[2J\u202e\u2069', '', undefined]) {
    const h = harness(t, 'waiting'), replies = [];
    h.before.questions = [{ id: 'native-editor', method: 'editor', title: 'Edit', prefill }];
    t.mock.method(AgentManager.prototype, 'reply', async (_id, _q, answer) => { replies.push(answer); return h.before; });
    h.ctx.ui.editor = async (_title, shown) => {
      if (shown !== undefined) assert.doesNotMatch(shown, /[\x1b\u202e\u2069]/u);
      if (prefill) assert.notEqual(shown, prefill, 'the visible prefill is escaped');
      return shown;
    };
    try {
      h.open(); h.press('i'); h.press('r');
      await waitUntil('unchanged editor reply', () => h.messages.length === 1, 2000);
      assert.deepEqual(replies, [prefill === undefined ? { cancelled: true } : { value: prefill }]);
      assert.equal(h.before.questions[0].prefill, prefill);
    } finally { await h.close(); }
  }
});

test('all native dialog displays escape controls and preserve exact response values', async t => {
  const poison = '\x1b[2J\u202e\u2069', displays = [];
  for (const method of ['confirm', 'select', 'input', 'editor']) {
    const h = harness(t, 'waiting'), replies = [];
    const q = { id: 'native', method, title: 'Title' + poison, message: 'Command' + poison,
      options: ['Same' + poison, 'Same\\u001b[2J\\u202e\\u2069'], placeholder: 'Hint' + poison, prefill: 'Text' + poison };
    h.before.questions = [q];
    const reply = t.mock.method(AgentManager.prototype, 'reply', async (_id, _q, answer) => { replies.push(answer); return h.before; });
    const show = (...args) => { displays.push(...args.flat().filter(x => typeof x === 'string')); };
    h.ctx.ui.confirm = async (...args) => { show(...args); return false; };
    h.ctx.ui.select = async (title, options) => { show(title, options); return options[0]; };
    h.ctx.ui.input = async (...args) => { show(...args); return 'answer' + poison; };
    h.ctx.ui.editor = async (...args) => { show(...args); return 'edited' + poison; };
    try {
      h.open(); h.press('i'); h.press('r');
      await waitUntil('dialog reply', () => h.messages.length === 1, 2000);
      assert.deepEqual(replies, [method === 'confirm' ? { confirmed: false } : { value: method === 'select' ? q.options[0] : (method === 'input' ? 'answer' : 'edited') + poison }]);
      assert.equal(q.title, 'Title' + poison);
    } finally { reply.mock.restore(); await h.close(); }
  }
  for (const text of displays) assert.doesNotMatch(text, /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202e\u2069]/u);
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
