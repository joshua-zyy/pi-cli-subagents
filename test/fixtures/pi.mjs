// Deterministic RPC fixture: no model/network/configuration access.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { writeJson } from '../../dist/storage.js';
const flag = (name) => process.argv[process.argv.indexOf(name) + 1];
const sessionFile = process.argv.includes('--session') ? flag('--session') : path.join(flag('--session-dir'), 'fake-session.json');
fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
// Native header identity, with fixture-only task state in extra fields (no real model history).
const session = fs.existsSync(sessionFile) ? JSON.parse(fs.readFileSync(sessionFile, 'utf8')) : { type: 'session', version: 3, id: randomUUID(), cwd: process.cwd(), timestamp: new Date().toISOString(), messages: [] };
let active = false, buffer = '', question = false, settling, traceInputs = false;
// Controlled input probes read progress concurrently; reuse the existing atomic
// writer for those snapshots rather than exposing a truncate/write window.
const save = () => traceInputs ? writeJson(sessionFile, session) : fs.writeFileSync(sessionFile, JSON.stringify(session));
const deferredInputs = new Map();
const emit = (record) => process.stdout.write(JSON.stringify(record) + '\n');
const response = (cmd, data = {}) => emit({ type: 'response', id: cmd.id, command: cmd.type, success: true, data });
const dialogs = new Map();
const independentDialogs = new Map();
let startupDialogOpened = false;
function independentDialog(record, onReply = () => {}) {
  independentDialogs.set(record.id, onReply);
  emit({ type: 'extension_ui_request', ...record });
}
async function askParent() {
  const at = process.argv.findIndex((value, i) => value === '--extension' && path.basename(process.argv[i + 1] ?? '') === 'pi-question-tool.js');
  if (at < 0) throw new Error('The child question resource was not explicitly loaded');
  const registered = [];
  const module = await import(pathToFileURL(process.argv[at + 1]).href);
  module.default({registerTool:tool=>registered.push(tool)});
  const tool = registered.find(tool=>tool.name === 'subagent_ask_parent');
  if (!tool) throw new Error('The child question tool was not registered');
  const args = {questions:[{header:'Tests',question:'Which existing tests should run?',options:[
    {label:'Unit',description:'Fast tests'}, {label:'Integration',description:'Full local scenario'},
  ]}]};
  const callId='parent-call';
  const dialog=(method,title,extra)=>new Promise(resolve=>{
    const id=randomUUID(); dialogs.set(id,resolve);
    emit({type:'extension_ui_request',id,method,title,...extra});
  });
  emit({type:'tool_execution_start',toolCallId:callId,toolName:tool.name,args});
  const result=await tool.execute(callId,args,undefined,undefined,{hasUI:true,mode:'rpc',ui:{
    select:(title,options)=>dialog('select',title,{options}),
    input:(title,placeholder)=>dialog('input',title,{placeholder}),
  }});
  emit({type:'tool_execution_end',toolCallId:callId,toolName:tool.name,result,isError:false});
  finish(JSON.stringify(result.details));
}
function finish(text, stopReason = 'stop') {
  const message = { role: 'assistant', content: [{ type: 'text', text }], stopReason };
  session.messages.push(message); save();
  emit({ type: 'message_end', message }); emit({ type: 'agent_end' });
  clearTimeout(settling);
  settling = setTimeout(() => {
    active = false;
    if (traceInputs) { session.fixtureActive = false; session.fixtureSettledCount = (session.fixtureSettledCount ?? 0) + 1; save(); }
    emit({ type: 'agent_settled' });
  }, 100);
}
function handle(cmd) {
  if (cmd.type === 'fixture/finish') return finish(cmd.text);
  if (cmd.type === 'fixture/pending') { session.fixturePendingCount = cmd.count; save(); return response(cmd); }
  if (cmd.type === 'fixture/emit') { for (const record of cmd.records) emit(record); return; }
  if (cmd.type === 'fixture/dialog') return independentDialog(cmd.dialog);
  if (cmd.type === 'get_state') {
    if (traceInputs) { session.fixtureStateReads = (session.fixtureStateReads ?? 0) + 1; save(); }
    const state = { sessionId: session.id, sessionFile, isStreaming: active,
      ...(session.fixturePendingCount !== undefined ? { pendingMessageCount: session.fixturePendingCount } : {}) };
    if (!startupDialogOpened && ['--startup-dialog', '--startup-dialog-after-state', '--startup-dialog-with-state'].some(flag => process.argv.includes(flag))) {
      startupDialogOpened = true;
      const afterState = process.argv.includes('--startup-dialog-after-state'), withState = process.argv.includes('--startup-dialog-with-state');
      if (afterState) response(cmd, state);
      independentDialog({ id: 'startup-dialog', method: 'confirm', title: 'Confirm fixture startup', message: 'Fixture session_start dialog' },
        () => { if (!afterState && !withState) response(cmd, state); });
      if (withState) response(cmd, state);
      return;
    }
    return response(cmd, state);
  }
  if (cmd.type === 'get_messages') return response(cmd, { messages: session.messages });
  if (cmd.type === 'clear_queue') return response(cmd);
  if (cmd.type === 'abort') {
    if (process.argv.includes('--ignore-interrupt')) return;
    if (process.argv.includes('--ack-interrupt-only')) return response(cmd);
    clearTimeout(settling); finish('ABORTED', 'aborted'); return response(cmd);
  }
  if (cmd.type === 'extension_ui_response') {
    if (independentDialogs.has(cmd.id)) {
      const onReply = independentDialogs.get(cmd.id); independentDialogs.delete(cmd.id);
      (session.fixtureReplies ??= []).push(cmd); save(); onReply(cmd); return;
    }
    if (dialogs.has(cmd.id)) { const resolve=dialogs.get(cmd.id); dialogs.delete(cmd.id); resolve(cmd.cancelled ? undefined : cmd.value); return; }
    if (!question || cmd.id !== 'permission-1') throw new Error('wrong UI response');
    question = false; return finish(cmd.cancelled ? 'CANCELLED' : cmd.value ?? (cmd.confirmed ? 'ALLOW' : 'DENY'));
  }
  if (cmd.type !== 'prompt') return emit({ type: 'response', id: cmd.id, success: false, error: 'unsupported command' });
  if (cmd.streamingBehavior && cmd.message.startsWith('DEFER_INPUT ')) {
    // Model the real asynchronous input-handler window. A separate test-owned
    // file releases preflight; get_state must not be needed to make progress.
    const input = JSON.parse(cmd.message.slice(12));
    if (!/^[a-z0-9-]+$/.test(input.key) || deferredInputs.has(input.key)) throw new Error('invalid deferred input key');
    traceInputs = true;
    (session.fixtureInputRequests ??= []).push(input.key); save();
    if (deferredInputs.size === 0 && active) finish('A done');
    const timer = setInterval(() => {
      if (!fs.existsSync(path.join(process.cwd(), `input-${input.key}.release`))) return;
      clearInterval(timer); deferredInputs.delete(input.key);
      if (input.outcome === 'reject') return emit({ type: 'response', id: cmd.id, success: false, error: 'fixture preflight rejected' });
      if (input.outcome === 'handled') return response(cmd, { disposition: 'handled' });
      if (input.outcome === 'queued') { session.fixturePendingCount = 1; save(); return response(cmd, { disposition: 'queued' }); }
      handle({ ...cmd, message: input.message });
    }, 10);
    deferredInputs.set(input.key, timer);
    return;
  }
  if (cmd.message === 'REJECT') return emit({ type: 'response', id: cmd.id, success: false, error: 'rejected by fixture' });
  if (active && !cmd.streamingBehavior) return emit({ type: 'response', id: cmd.id, success: false, error: 'already running' });
  session.messages.push({ role: 'user', content: cmd.message }); save();
  // Keep the actual baseline notice in the native transcript, then execute the fixture task.
  if (cmd.message.includes('\n\n[Workspace baseline]\n')) cmd = { ...cmd, message: cmd.message.split('\n\n[Workspace baseline]\n')[0] };
  const disposition = active ? 'queued' : 'started';
  active = true;
  if (traceInputs) { session.fixtureActive = true; save(); }
  response(cmd, { disposition }); emit({ type: 'agent_start' });
  if (cmd.message.startsWith('HOLD')) return;
  if (cmd.message === 'ASK_PARENT') { void askParent().catch(error=>finish(error.message,'error')); return; }
  if (cmd.message === 'RUNTIME_UI') {
    independentDialog({ id: 'runtime-dialog', method: 'confirm', title: 'Independent fixture configuration' });
    return finish('original-result');
  }
  if (cmd.message === 'STREAM') {
    emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Inspecting implementation' } });
    emit({ type: 'tool_execution_start', toolCallId: 'stream-call', toolName: 'read', args: { path: 'src/example.ts' } });
    emit({ type: 'tool_execution_update', toolCallId: 'stream-call', toolName: 'read', partialResult: { content: [{ type: 'text', text: 'partial fixture output' }] } });
    setTimeout(() => {
      emit({ type: 'tool_execution_end', toolCallId: 'stream-call', toolName: 'read', result: { content: [{ type: 'text', text: 'final fixture output' }] }, isError: false });
      finish('Implementation complete');
    }, 1500);
    return;
  }
  if (cmd.message === 'WAIT_INPUT' || cmd.message === 'WAIT_EDITOR' || cmd.message === 'WAIT_EXPIRED') {
    question = true;
    const editor = cmd.message === 'WAIT_EDITOR', expires = cmd.message === 'WAIT_EXPIRED';
    emit({ type: 'extension_ui_request', id: 'permission-1', method: editor ? 'editor' : 'input', title: 'Provide fixture context',
      ...(editor ? { prefill: 'original\ncontext' } : { placeholder: 'exact text' }), ...(expires ? { timeout: 1500 } : {}) });
    if (expires) setTimeout(() => { question = false; finish('EXPIRED'); }, 1500);
    return;
  }
  if (cmd.message === 'WAIT' || cmd.message === 'WAIT_SELECT' || cmd.message === 'WAIT_SAFETY') {
    question = true;
    emit(cmd.message === 'WAIT' ?
      { type: 'extension_ui_request', id: 'permission-1', method: 'confirm', title: 'Allow fixture operation?', message: 'Confirm this fixture-only action' } :
      cmd.message === 'WAIT_SAFETY' ?
      // Typical safety-guard labels are just one native dialog, not a special protocol identity.
      { type: 'extension_ui_request', id: 'permission-1', method: 'select', title: 'Dangerous bash command', message: 'Reason: possible secret file access',
        options: ['Block', 'Allow once', 'Allow for this session', 'Always allow in this cwd'] } :
      { type: 'extension_ui_request', id: 'permission-1', method: 'select', title: 'Select fixture response', options: ['Allow once', 'Deny'] });
    return;
  }
  if (cmd.message === 'FAIL') return finish('', 'error');
  if (cmd.message === 'CRASH') return process.exit(2);
  if (cmd.message.startsWith('REMEMBER ')) { session.token = cmd.message.slice(9); save(); return finish('OK'); }
  if (cmd.message === 'RECALL') return finish(session.token ?? 'MISSING');
  if (cmd.message === 'CWD') return finish(process.cwd());
  if (cmd.message.startsWith('FILE ')) {
    const { file, content } = JSON.parse(cmd.message.slice(5));
    const target = path.resolve(file), relative = path.relative(process.cwd(), target);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('Fixture files must stay in cwd');
    if (content !== undefined) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); }
    return finish(fs.readFileSync(target, 'utf8'));
  }
  if (cmd.message === 'UNICODE') return finish('A\u2028B\u2029\u96ea');
  finish(cmd.message);
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let n;
  while ((n = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, n); buffer = buffer.slice(n + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => { clearTimeout(settling); for (const timer of deferredInputs.values()) clearInterval(timer); deferredInputs.clear(); });
