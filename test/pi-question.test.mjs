import test from 'node:test';
import assert from 'node:assert/strict';
import { PiAdapter } from '../dist/pi-adapter.js';
import questionTool from '../dist/pi-question-tool.js';

const args = {questions:[{header:'Tests',question:'Which existing tests should run?',options:[
  {label:'Unit',description:'Fast tests'}, {label:'Integration',description:'Full local scenario'},
]}]};
const options = ['1. Unit — Fast tests','2. Integration — Full local scenario','3. Type something.'];
const title = (id,method='select') => '[pi-cli-subagents:question:v1:'+encodeURIComponent(id)+':'+method+']\n[Tests] Which existing tests should run?'+(method==='input'?'\n\nType your answer:':'');
function setup() {
  const events=[],writes=[];
  // Feed the actual adapter's event boundary without creating a CLI or a model.
  const rpc={reply:async answer=>{writes.push(answer);},stop:async()=>{},end:async()=>{}};
  const adapter=Object.assign(Object.create(PiAdapter.prototype), {rpc,options:{onEvent:e=>events.push(e)},parentCalls:new Map()});
  const start=(id,input=args)=>adapter.event({type:'tool_execution_start',toolCallId:id,toolName:'subagent_ask_parent',args:input});
  const end=id=>adapter.event({type:'tool_execution_end',toolCallId:id,toolName:'subagent_ask_parent'});
  const dialog=(id,callId,extra={})=>adapter.event({type:'extension_ui_request',id,method:'select',title:title(callId),options,...extra});
  const input=(id,callId,extra={})=>adapter.event({type:'extension_ui_request',id,method:'input',title:title(callId,'input'),placeholder:'',...extra});
  return {adapter,rpc,events,writes,start,end,dialog,input,questions:()=>events.filter(e=>e.type==='question').map(e=>e.question)};
}

test('Pi publishes logical choices once and withdraws only the ended call and its cached answer',async()=>{
  const {adapter,events,writes,start,end,dialog,questions}=setup();
  start('call/A');start('call/B');
  assert.equal(questions().length,2,'questions are independent of the native dialog arrival');
  const [a,b]=questions();assert.notEqual(a.id,b.id);
  for(const q of questions()){
    assert.equal(q.kind,'question');assert.equal(q.humanOnly,false);
    assert.deepEqual(q.options,['Unit','Integration']);
    assert.deepEqual(q.parentPolicy,{values:['Unit','Integration'],text:true});
    assert.equal(q.title,'[Tests] Which existing tests should run?');
    assert.match(q.message,/Fast tests/);assert.match(q.message,/Full local scenario/);
  }
  await adapter.reply({type:'reply',id:a.id,value:'must not leak after tool end'});
  end('call/A');
  assert(events.some(e=>e.type==='resolved'&&e.id===a.id));
  assert(!events.some(e=>e.type==='resolved'&&e.id===b.id));
  dialog('late-A','call/A');assert.equal(questions().at(-1).id,'late-A');assert.equal(questions().at(-1).kind,undefined);
  assert.deepEqual(writes,[]);
});

test('one logical answer drives the Pi dialogs regardless of which arrives first',async t=>{
  for(const first of ['answer','dialog'])for(const mode of ['option','custom','cancel'])await t.test(`${first} first: ${mode}`,async()=>{
    const {adapter,writes,start,dialog,input,questions}=setup();
    start('call/A');const q=questions()[0];
    assert(q,'a logical question is emitted on tool start');
    if(first==='dialog')dialog('menu','call/A');
    await adapter.reply({type:'reply',id:q.id,...(mode==='cancel'?{cancelled:true}:{value:mode==='option'?'Unit':'Only the focused regression.'})});
    if(first==='answer'){assert.deepEqual(writes,[]);dialog('menu','call/A');}
    assert.deepEqual(writes,[mode==='cancel'?{id:'menu',cancelled:true}:{id:'menu',value:options[mode==='option'?0:2]}]);
    if(mode==='custom'){
      input('text','call/A');
      assert.deepEqual(writes[1],{id:'text',value:'Only the focused regression.'});
    }
    assert.equal(questions().length,1,'no second question escapes to the caller');
  });
});

test('interleaved custom answers stay bound to their own call through both UI stages',async()=>{
  const {adapter,writes,start,dialog,input,questions}=setup();
  start('call/A');start('call/B');const [a,b]=questions();
  assert(a&&b);
  dialog('select-B','call/B');
  await adapter.reply({type:'reply',id:a.id,value:'alpha'});
  await adapter.reply({type:'reply',id:b.id,value:'beta'});
  dialog('select-A','call/A');input('input-B','call/B');input('input-A','call/A');
  assert.deepEqual(writes,[{id:'select-B',value:options[2]},{id:'select-A',value:options[2]},
    {id:'input-B',value:'beta'},{id:'input-A',value:'alpha'}]);
  assert.equal(questions().length,2);
});

test('cached answers never consume unknown, mismatched, permission or out-of-stage dialogs',async()=>{
  const {adapter,writes,start,dialog,input,questions}=setup();
  dialog('unknown','call/A');
  start('call/A');const logical=questions().find(q=>q.kind==='question');assert(logical);
  await adapter.reply({type:'reply',id:logical.id,value:'private task context'});
  dialog('wrong-call','other');
  dialog('wrong-title','call/A',{title:'Which existing tests should run?'});
  dialog('guard-reordered','call/A',{options:['Allow once','Block','Allow for this session','Always allow in this cwd']});
  dialog('wrong-method','call/A',{method:'confirm',options:undefined});
  input('too-early','call/A');
  start('invalid',{questions:[{header:'Tests',question:'x',options:[]}]});dialog('invalid-args','invalid');
  for(const q of questions().filter(q=>q!==logical)){
    assert.equal(q.humanOnly,false,q.id);assert.equal(q.kind,undefined,q.id);
    assert.deepEqual(q.parentPolicy,q.method==='confirm'?{confirm:true}:q.method==='select'?{values:q.options}:{text:true},q.id);
  }
  dialog('ordinary-permission','call/A',{options:['Block','Allow once','Allow for this session','Always allow in this cwd']});
  assert.equal(questions().at(-1).kind,undefined);
  assert.deepEqual(questions().at(-1).parentPolicy,{values:['Block','Allow once','Allow for this session','Always allow in this cwd']});
  assert.deepEqual(writes,[]);
  dialog('own-select','call/A');
  input('foreign-input','call/A',{title:'Type your answer:'});
  input('modified-input','call/A',{placeholder:'another contract'});
  assert.equal(questions().at(-1).id,'modified-input');assert.equal(writes.length,1);
  input('own-input','call/A');assert.deepEqual(writes[1],{id:'own-input',value:'private task context'});
  input('extra-input','call/A');assert.equal(questions().at(-1).id,'extra-input');assert.equal(questions().at(-1).kind,undefined);
  assert.equal(writes.length,2,'a completed answer cannot be replayed into another input');
});

test('closing the adapter discards answers before late UI events can replay them',async()=>{
  for(const method of ['stop','end']){
    const {adapter,writes,start,dialog,questions}=setup();start('call/A');const q=questions()[0];assert(q);
    await adapter.reply({type:'reply',id:q.id,value:'pending context'});
    await adapter[method]();dialog('late','call/A');
    assert.deepEqual(writes,[]);assert.equal(questions().at(-1).id,'late');assert.equal(questions().at(-1).kind,undefined);
  }
});

test('failed initial or automatic UI writes fail the run and discard the cached answer',async()=>{
  for(const stage of ['select','input']){
    const {adapter,rpc,events,writes,start,dialog,input,questions}=setup();start('call/A');const q=questions()[0];assert(q);
    rpc.reply=async answer=>{writes.push(answer);if(answer.id===stage)throw new Error('fixture write failed');};
    dialog('select','call/A');
    const reply=adapter.reply({type:'reply',id:q.id,value:'pending context'});
    if(stage==='select')await assert.rejects(reply,/fixture write failed/);
    else {await reply;input('input','call/A');await new Promise(resolve=>setImmediate(resolve));}
    assert(events.some(e=>e.type==='settled'&&e.status==='failed'&&e.stop&&e.error.includes('fixture write failed')));
    const count=writes.length;input('late','call/A');assert.equal(writes.length,count);
  }
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
