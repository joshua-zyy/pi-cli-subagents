import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import extension from '../dist/index.js';
import { AgentManager } from '../dist/manager.js';
import { waitUntil, processAlive } from '../dist/storage.js';

const fixture = fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url));
const out = path.resolve('.test-output');fs.mkdirSync(out,{recursive:true});
test('only a human command can respond to a blocking UI question', {timeout:12000}, async t=>{
  const saved = process.argv[1];process.argv[1] = fixture;
  const cwd = fs.mkdtempSync(path.join(out,'approve-'));
  const parent = path.join(cwd,'parent.jsonl');fs.writeFileSync(parent,'{}\n');
  const tools = new Map(), commands = new Map(), notices=[];
  let confirmations=0;
  const ctx = {cwd, hasUI:true, isProjectTrusted:()=>false,
    sessionManager:{ getSessionFile:()=>parent, getEntries:()=>[] },
    ui:{notify:(message)=>notices.push(message),confirm:async()=>{confirmations++;return false;}}};
  extension({on(){},registerTool(tool){tools.set(tool.name,tool)},registerCommand(name,def){commands.set(name,def)}});
  const manager = new AgentManager(parent,{command:process.execPath,args:[fixture]});
  t.after(async()=>{for(const s of manager.list())if(processAlive(s.workerPid))await manager.close(s.id);process.argv[1]=saved;});
  assert.equal(tools.has('agent-reply'),false);
  const result = await tools.get('spawn_agent').execute('id',{role:'worker',task:'WAIT',cwd},undefined,undefined,ctx);
  const id = JSON.parse(result.content[0].text.match(/\{.+\}/)[0]).id;
  await waitUntil('waiting',()=>manager.get(id).phase==='waiting');
  assert.equal(confirmations,0);
  await commands.get('agent-reply').handler(`${id} permission-1`,ctx);
  await waitUntil('complete',()=>manager.get(id).phase==='completed'&&!processAlive(manager.get(id).workerPid));
  assert.equal(confirmations,1);
  assert.equal(manager.get(id).text,'DENY');
  assert.ok(notices.some(message=>message.includes('Human response sent to subagent')));
});
