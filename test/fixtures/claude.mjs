import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
const args = process.argv.slice(2), value = key => args[args.indexOf(key) + 1];
const home = process.env.CLAUDE_CONFIG_DIR;
if (!home || !fs.existsSync(path.join(home, 'fixture-home'))) throw Error('Fixture requires an isolated marked home');
const sessionId = args.includes('--resume') ? value('--resume') : value('--session-id');
const file = path.join(home, 'projects', 'fixture-project', `${sessionId}.jsonl`);
const emit = frame => process.stdout.write(JSON.stringify(frame) + '\n');
// The real 2.1.283 local stream emitted no session_state_changed messages.
const system = (subtype, extra = {}) => {
  if (subtype === 'session_state_changed' && !args.includes('--state-events')) return;
  emit({ type: 'system', subtype, uuid: randomUUID(), session_id: sessionId, ...extra });
};
const success = (request_id, response = {}) => emit({ type: 'control_response', response: { subtype: 'success', request_id, response } });
const requests = path.join(home, 'requests.jsonl');
fs.appendFileSync(path.join(home, 'launches.jsonl'), JSON.stringify({args, cwd: process.cwd()}) + '\n');
let active, task, approval, remembered = '';
if (args.includes('--resume')) {
  if (!fs.existsSync(file)) throw Error('Original session missing');
  for (const row of fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)) {
    if (row.message?.content?.startsWith('REMEMBER ')) remembered = row.message.content.slice(9);
  }
}
const finish = (text = 'OK', extra = {}) => {
  const uuid = active; active = undefined;
  emit({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId,
    uuid: randomUUID(), user_message_uuid: uuid, user_message_uuids: [uuid], result: text,
    terminal_reason: 'completed', queued_turn_count: 0, ...extra });
  system('session_state_changed', { state: 'idle' });
};
const ask = (extra = {}) => {
  const toolId = randomUUID();
  emit({ type: 'assistant', session_id: sessionId, parent_tool_use_id: null,
    message: { id: randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Write', input: { file_path: 'work.txt', content: 'fixture' } }] } });
  approval = { type: 'control_request', request_id: randomUUID(), request: { subtype: 'can_use_tool', tool_name: 'Write',
    tool_use_id: toolId, input: { file_path: 'work.txt', content: 'fixture' }, ...extra } };
  emit(approval);
};
for await (const line of readline.createInterface({ input: process.stdin })) {
  const record = JSON.parse(line); fs.appendFileSync(requests, JSON.stringify(record) + '\n');
  if (record.type === 'control_request') {
    const { subtype } = record.request;
    if (subtype === 'initialize') {
      if (args.includes('--resume') && args.includes('--reject-resume')) {
        emit({type:'control_response',response:{subtype:'error',request_id:record.request_id,error:'fixture resume rejected'}}); continue;
      }
      success(record.request_id, { session_state: 'idle', commands: [], models: [], account: {}, agents: [] });
      if (!args.includes('--no-identity')) system('commands_changed', { commands: [], ...(args.includes('--wrong-identity') ? { session_id: randomUUID() } : {}) });
      if (args.includes('--early-approval')) ask();
    } else if (subtype === 'get_binary_version') success(record.request_id, { version: '2.1.283' });
    else if (subtype === 'list_permission_rules') success(record.request_id, { state: { originalCwd: args.includes('--wrong-cwd') ? path.dirname(process.cwd()) : process.cwd(), rules: [], workspaceDirectories: [], errors: [] } });
    else if (subtype === 'interrupt') {
      if (args.includes('--ignore-interrupt')) continue;
      success(record.request_id, { still_queued: [], cancelled: [] });
      if (active) finish('INTERRUPTED', { terminal_reason: 'aborted_tools' });
    } else emit({ type: 'control_response', response: { subtype: 'error', request_id: record.request_id, error: 'Unsupported fixture control' } });
  } else if (record.type === 'user') {
    active = record.uuid; task = record.message.content.split('\n')[0];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ type: 'user', uuid: active, parentUuid: null, sessionId, cwd: process.cwd(), message: record.message }) + '\n');
    if (task === 'CRASH') { process.exit(7); }
    if (task === 'NOISE') { process.stdout.write('not-json\n'); continue; }
    system('init', { cwd: args.includes('--wrong-init-cwd') ? path.dirname(process.cwd()) : process.cwd(), claude_code_version: '2.1.283', model: 'fixture-model', capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1'], ...(args.includes('--wrong-init') ? { session_id: randomUUID() } : {}) });
    system('session_state_changed', { state: 'running' });
    emit({ ...record, session_id: sessionId, isReplay: true });
    if (task === 'HOLD') continue;
    if (task === 'FAIL') { finish('model failed', { is_error: true, terminal_reason: 'api_error' }); continue; }
    if (task === 'QUEUE_NONEMPTY') { finish('MORE TO DO', { queued_turn_count: 1 }); continue; }
    if (task === 'FOREIGN_RESULT') emit({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, user_message_uuid: randomUUID(), result: 'FOREIGN', queued_turn_count: 0 });
    if (task === 'BACKGROUND') {
      system('task_started', { task_id: 'background', is_backgrounded: true });
      finish('ROOT');
      continue;
    }
    if (task.startsWith('APPROVAL')) {
      ask(task === 'APPROVAL_MANUAL' ? { classifier_approvable: false, default_to_no: true } :
        task === 'APPROVAL_DIALOG' ? { requires_user_interaction: true } :
        task === 'APPROVAL_UNSCOPED' ? { tool_use_id: 'foreign' } :
        task === 'APPROVAL_NO_NAME' ? { tool_use_id: 'foreign', tool_name: undefined } : {});
      if (task === 'APPROVAL_EXPIRED') { emit({ type: 'control_cancel_request', request_id: approval.request_id }); finish('EXPIRED'); }
      if (task === 'APPROVAL_DUPLICATE') emit(approval);
      continue;
    }
    if (task.startsWith('FILE ')) {
      const {file,content}=JSON.parse(task.slice(5)); const target=path.resolve(process.cwd(),file);
      if(content!==undefined)fs.writeFileSync(target,content);
      finish(fs.readFileSync(target,'utf8')); continue;
    }
    if (task.startsWith('REMEMBER ')) remembered = task.slice(9);
    finish(task === 'RECALL' ? remembered : task === 'CWD' ? process.cwd() : task === 'FOREIGN_RESULT' ? 'CURRENT' : 'OK');
  } else if (record.type === 'fixture/release-background') {
    system('task_notification', { task_id: 'background', status: 'completed', summary: 'finished' });
  } else if (record.type === 'control_response' && active) {
    const r = record.response.response;
    if (r?.behavior === 'allow') finish('ALLOW');
    else finish('DENY', r?.interrupt ? { terminal_reason: 'aborted_tools' } : {});
  }
}
