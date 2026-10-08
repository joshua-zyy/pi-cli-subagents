import test from 'node:test';
import assert from 'node:assert/strict';
import { PiAdapter } from '../dist/pi-adapter.js';
import questionTool from '../dist/pi-question-tool.js';

const args = {questions:[{header:'Tests',question:'Which existing tests should run?',options:[
  {label:'Unit',description:'Fast tests'}, {label:'Integration',description:'Full local scenario'},
]}]};
const options = ['1. Unit — Fast tests','2. Integration — Full local scenario','3. Type something.'];
const title = id => '[pi-cli-subagents:question:v1:'+encodeURIComponent(id)+':select]\n[Tests] Which existing tests should run?';
function setup() {
  const events=[];
  // Feed the actual adapter's event boundary without creating a CLI or a model.
  const adapter=Object.assign(Object.create(PiAdapter.prototype), {options:{onEvent:e=>events.push(e)},parentCalls:new Map()});
  const start=(id,input=args)=>adapter.event({type:'tool_execution_start',toolCallId:id,toolName:'subagent_ask_parent',args:input});
  const dialog=(id,callId,extra={})=>adapter.event({type:'extension_ui_request',id,method:'select',title:title(callId),options,...extra});
  return {adapter,events,start,dialog,questions:()=>events.filter(e=>e.type==='question').map(e=>e.question)};
}

test('Pi ordinary questions bind interleaved dialogs to their tool calls and withdraw on tool end',()=>{
  const {adapter,events,start,dialog,questions}=setup();
  start('call/A');start('call/B');dialog('dialog-B','call/B');dialog('dialog-A','call/A');
  assert.equal(questions().length,2);
  for(const q of questions()){
    assert.equal(q.kind,'question');assert.equal(q.humanOnly,false);
    assert.deepEqual(q.parentPolicy,{values:options});
    assert.equal(q.title,'[Tests] Which existing tests should run?');
    assert(!q.title.includes('pi-cli-subagents:question'));
  }
  adapter.event({type:'tool_execution_end',toolCallId:'call/A',toolName:'subagent_ask_parent'});
  assert(events.some(e=>e.type==='resolved'&&e.id==='dialog-A'));
  assert(!events.some(e=>e.type==='resolved'&&e.id==='dialog-B'));
  dialog('late-A','call/A');assert.equal(questions().at(-1).humanOnly,true);
});

test('Pi does not turn unknown, mismatched or modified approval dialogs into ordinary questions',()=>{
  const {adapter,start,dialog,questions}=setup();
  dialog('unknown','call/A');
  start('call/A');dialog('wrong-call','other');
  dialog('wrong-title','call/A',{title:'Which existing tests should run?'});
  dialog('guard-reordered','call/A',{options:['Allow once','Block','Allow for this session','Always allow in this cwd']});
  dialog('wrong-method','call/A',{method:'confirm',options:undefined});
  start('invalid',{questions:[{header:'Tests',question:'x',options:[]}]});dialog('invalid-args','invalid');
  for(const q of questions()) {assert.equal(q.humanOnly,true,q.id);assert.equal(q.kind,undefined,q.id);assert.equal(q.parentPolicy,undefined,q.id);}
  adapter.event({type:'extension_ui_request',id:'foreign-input',method:'input',title:'Type your answer:'});
  assert.equal(questions().at(-1).humanOnly,true);
  adapter.event({type:'extension_ui_request',id:'own-input',method:'input',
    title:'[pi-cli-subagents:question:v1:call%2FA:input]\n[Tests] Which existing tests should run?\n\nType your answer:',placeholder:''});
  assert.equal(questions().at(-1).kind,'question');
  assert.deepEqual(questions().at(-1).parentPolicy,{text:true});
});

test('the bundled resource is child-only, validates its subset, observes abort and never guesses a choice',async()=>{
  const prior=process.env.PI_CLI_SUBAGENT,registered=[];
  try {
    delete process.env.PI_CLI_SUBAGENT;questionTool({registerTool:t=>registered.push(t)});assert.equal(registered.length,0);
    process.env.PI_CLI_SUBAGENT='1';questionTool({registerTool:t=>registered.push(t)});
    assert.deepEqual(registered.map(t=>t.name),['subagent_ask_parent']);
    const tool=registered[0];let dialogs=0;
    const ctx={mode:'rpc',hasUI:true,ui:{select:async()=>{dialogs++;return 'not offered';},input:async()=>{throw new Error('No choice may be invented');}}};
    for(const invalid of [{questions:[]},{questions:[...args.questions,...args.questions]},
      {questions:[{...args.questions[0],multiSelect:true}]},
      {questions:[{...args.questions[0],options:[args.questions[0].options[0],args.questions[0].options[0]]}]}]){
      await assert.rejects(tool.execute('call',invalid,undefined,undefined,ctx),/Expected one question/);
    }
    assert.equal(dialogs,0);
    await assert.rejects(tool.execute('call',args,undefined,undefined,{...ctx,mode:'tui'}),/child Pi RPC/);
    const result=await tool.execute('call',args,undefined,undefined,ctx);
    assert.deepEqual(result.details,{answers:[],cancelled:true});assert.equal(dialogs,1);
    for(const stage of ['select','input']){
      const controller=new AbortController();let opened;
      const ready=new Promise(resolve=>{opened=resolve;});
      const waitForAbort=(_title,_values,opts)=>new Promise(resolve=>{
        if(opts?.signal?.aborted)resolve(undefined);
        else opts?.signal?.addEventListener('abort',()=>resolve(undefined),{once:true});
        opened();
      });
      const execution=tool.execute('call',args,controller.signal,undefined,{...ctx,ui:{
        select:stage==='select'?waitForAbort:async(_title,choices)=>choices.at(-1),input:waitForAbort,
      }});
      await ready;controller.abort();
      let timer;
      try {
        const cancelled=await Promise.race([execution,new Promise(resolve=>{timer=setTimeout(()=>resolve('still waiting'),250);})]);
        assert.notEqual(cancelled,'still waiting',`aborting ${stage} must release the dialog without a parent reply`);
        assert.deepEqual(cancelled.details,{answers:[],cancelled:true});
      } finally {clearTimeout(timer);}
    }
  } finally {if(prior===undefined)delete process.env.PI_CLI_SUBAGENT;else process.env.PI_CLI_SUBAGENT=prior;}
});
