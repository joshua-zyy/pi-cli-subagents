// Explicit opt-in; two small real Pi model calls. Never run as part of npm test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { AgentManager } from '../dist/manager.js';
import { defaultRoles } from '../dist/roles.js';
import { processAlive, waitUntil } from '../dist/storage.js';

const cli = process.env.PI_CLI_PATH ?? path.join(path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'bundle', 'cli.js');
const root = path.resolve('.test-output'); fs.mkdirSync(root, {recursive:true});
const cwd = fs.mkdtempSync(path.join(root, 'real-'));
const parent = path.join(cwd, 'parent.jsonl'); fs.writeFileSync(parent,'{}\n');
const manager = new AgentManager(parent,{command:process.execPath,args:[cli]});
const marker = `MARKER-${randomBytes(5).toString('hex')}`;
let id;
try {
  const start = await manager.spawn('worker',defaultRoles.worker,cwd,`Remember this marker for later: ${marker}. Reply only OK. No tools.`);
  id = start.id;
  const first = await waitUntil('first run',()=>{const s=manager.get(id);return s.phase==='completed'&&!processAlive(s.workerPid)?s:undefined},150000);
  assert.equal(first.text?.trim(),'OK');
  const next = await manager.send(id,'Which marker did I ask you to remember? Reply with only the marker. No tools.');
  const second = await waitUntil('resumed run',()=>{const s=manager.get(id);return s.runId===next.runId&&s.phase==='completed'&&!processAlive(s.workerPid)?s:undefined},150000);
  assert.equal(second.sessionId,first.sessionId);
  assert.equal(second.sessionFile,first.sessionFile);
  assert.equal(second.text?.trim(),marker);
  assert.ok(!processAlive(second.cliPid));
  console.log(JSON.stringify({passed:true,id,sessionId:first.sessionId,cwd,results:manager.reports().map(r=>({status:r.status,runId:r.runId}))},null,2));
} finally {
  if (id) {
    const state=manager.get(id);
    if(processAlive(state.workerPid))await manager.close(id);
  }
}
