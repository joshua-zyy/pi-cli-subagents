import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {TranscriptReader} from '../dist/ui/transcript.js';
const session_id='native';const root=fs.mkdtempSync(path.resolve('.test-output/claude-transcript-'));
async function snapshot(records,more=[]){const files=[records,...more].map((rows,i)=>{const f=path.join(root,`${crypto.randomUUID()}-${i}.jsonl`);fs.writeFileSync(f,rows.map(JSON.stringify).join('\n')+'\n');return f;});const r=new TranscriptReader('claude',session_id);let s;do{s=await r.read(files);}while(s.loading);return s;}
const result=(input,output,cost)=>({type:'result',subtype:'success',is_error:false,session_id,uuid:crypto.randomUUID(),modelUsage:{model:{inputTokens:input,outputTokens:output,cacheReadInputTokens:20,cacheCreationInputTokens:3}},total_cost_usd:cost});
test('Claude transcript merges streaming text with final snapshots and tool results',async()=>{
 const stream=event=>({type:'stream_event',session_id,parent_tool_use_id:null,event});
 const s=await snapshot([{type:'system',subtype:'init',session_id,model:'fixture'}, {type:'user',session_id,uuid:'u',message:{role:'user',content:'Task'}},
 stream({type:'message_start',message:{id:'m'}}),stream({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Hello 雪'}}),
 {type:'assistant',session_id,message:{id:'m',role:'assistant',content:[{type:'text',text:'Hello 雪'},{type:'tool_use',id:'tool',name:'Read',input:{file_path:'a'}}]}},
 {type:'user',session_id,uuid:'tr',message:{role:'user',content:[{type:'tool_result',tool_use_id:'tool',content:'contents',is_error:false}]}},
 {type:'assistant',session_id:'foreign',message:{id:'x',content:[{type:'text',text:'WRONG'}]}},
 {type:'assistant',session_id,parent_tool_use_id:'nested',message:{id:'nested',content:[{type:'text',text:'HIDDEN'}]}},result(10,2,.01)]);
 assert.equal(s.model,'fixture');assert.equal(s.entries.filter(e=>e.kind==='assistant').length,1);assert.equal(s.entries.find(e=>e.kind==='assistant').text,'Hello 雪');
 assert.equal(s.entries.filter(e=>e.kind==='user').length,1);const tool=s.entries.find(e=>e.kind==='tool');assert.equal(tool.status,'done');assert.equal(tool.text,'contents');assert.match(tool.input,/file_path/);
 assert.deepEqual(s.usage,{input:10,output:2,cacheRead:20,cacheWrite:3,cost:.01});
});
test('Claude cumulative usage is replaced across results and resumed files, not summed',async()=>{
 const s=await snapshot([result(10,2,.01),result(20,4,.02)],[[result(30,6,.03)]]);
 assert.equal(s.usage.input,30);assert.equal(s.usage.output,6);assert.equal(s.usage.cost,.03);
});
test('Claude early viewer learns identity, renders permission details and error results',async()=>{
 const file=path.join(root,'early.jsonl');fs.writeFileSync(file,[{type:'system',subtype:'commands_changed',session_id},
 {type:'control_request',request_id:'req',request:{subtype:'can_use_tool',tool_name:'Write',input:{file_path:'a',content:'review me'}}},
 {...result(1,0,.001),is_error:true,result:'API failure'},
 {...result(1,0,.001),subtype:'error_during_execution',is_error:true,errors:['Native failure']}].map(JSON.stringify).join('\n')+'\n');
 const s=await new TranscriptReader('claude').read([file]);assert(s.entries.some(e=>e.kind==='notice'&&e.text.includes('review me')));assert(s.entries.some(e=>e.status==='error'&&e.text.includes('API failure')));assert(s.entries.some(e=>e.status==='error'&&e.text.includes('Native failure')));
});
