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
  return {before,failed,notices,messages,calls,
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
