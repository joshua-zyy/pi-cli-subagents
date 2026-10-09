import fs from 'node:fs';
import assert from 'node:assert/strict';
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
const questionInput = {
  title: 'Fixture task questions', metadata: { source: 'fixture' }, questions: [
    { question: 'Which checks?', header: 'Checks', kind: 'choice', multiSelect: false, options: [
      { label: 'Read, write', description: 'Only the assigned workspace', preview: '<pre>work.txt</pre>' },
      { label: 'Review', description: 'Read only' },
    ] },
    { question: 'Which outputs?', header: 'Checks', multiSelect: true, options: [
      { label: 'Logs', description: 'Execution evidence' }, { label: 'Summary', description: 'Short report' },
    ] },
    { question: 'What marker?', header: 'Context', kind: 'text', description: 'Assigned context only', placeholder: 'Literal marker', options: [], multiSelect: false },
    { question: 'How many items?', header: 'Count', kind: 'number', options: [], multiSelect: false, min: 1, max: 10, step: 1, defaultValue: 2, unit: 'items' },
  ],
};
const questionRequests = new Map(), questionResults = [];
function askQuestion(extra = {}, input = structuredClone(questionInput)) {
  const toolId = randomUUID();
  emit({ type: 'assistant', session_id: sessionId, parent_tool_use_id: null,
    message: { id: randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'AskUserQuestion', input }] } });
  const request = { type: 'control_request', request_id: randomUUID(), request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion',
    tool_use_id: toolId, input, requires_user_interaction: true, ...extra } };
  questionRequests.set(request.request_id, request); emit(request); return request;
}
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
    if (task.startsWith('QUESTION')) {
      const input = structuredClone(questionInput);
      if (task === 'QUESTION_HOST_FIELDS') input.answers = {};
      if (task === 'QUESTION_INVALID') input.questions[0].kind = 'future-dialog';
      if (task === 'QUESTION_OVERSIZED') input.title = 'x'.repeat(12_001);
      const request = askQuestion(task === 'QUESTION_MANUAL' ? { classifier_approvable: false } :
        task === 'QUESTION_RULE' ? { matched_ask_rule: { source: 'userSettings', tool_name: 'AskUserQuestion' } } :
        task === 'QUESTION_REASON_RULE' ? { decision_reason_type: 'rule', decision_reason: 'User explicitly requested review' } :
        task === 'QUESTION_MCP' ? { mcp_server: { name: 'not-the-builtin' } } :
        task === 'QUESTION_BROWSER' ? { tool_kind: 'browser' } :
        task === 'QUESTION_HOOK' ? { decision_reason_type: 'hook' } :
        task === 'QUESTION_MODE' ? { decision_reason_type: 'mode' } :
        task === 'QUESTION_INVALID' ? { requires_user_interaction: false } : {}, input);
      if (task === 'QUESTION_PAIR') askQuestion({}, { ...structuredClone(questionInput), title: 'Second form' });
      if (task === 'QUESTION_DUPLICATE') emit(request);
      if (task === 'QUESTION_EXPIRED') { emit({ type: 'control_cancel_request', request_id: request.request_id }); finish('EXPIRED'); }
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
    if (questionRequests.has(record.response.request_id)) {
      const request = questionRequests.get(record.response.request_id).request;
      assert.equal(record.response.subtype, 'success'); assert.equal(r.toolUseID, request.tool_use_id);
      assert.equal(r.updatedPermissions, undefined);
      let answer;
      if (r.behavior === 'allow') {
        const { answers, ...shown } = r.updatedInput;
        assert.deepEqual(shown, request.input, 'the shown native input must not be rewritten');
        assert.deepEqual(Object.keys(answers).sort(), request.input.questions.map(q => q.question).sort());
        for (const q of request.input.questions) assert.equal(Array.isArray(answers[q.question]), q.multiSelect === true);
        answer = answers;
        emit({ type: 'user', session_id: sessionId, parent_tool_use_id: null, message: { role: 'user', content: [
          { type: 'tool_result', tool_use_id: request.tool_use_id, content: JSON.stringify(answer) },
        ] } });
      } else { assert.equal(r.behavior, 'deny'); assert.equal(r.interrupt, false); answer = 'QUESTION_CANCELLED'; }
      questionResults.push(answer); questionRequests.delete(record.response.request_id);
      if (!questionRequests.size) finish(task === 'QUESTION_PAIR' ? JSON.stringify(questionResults) : typeof answer === 'string' ? answer : JSON.stringify(answer));
    } else if (r?.behavior === 'allow') finish('ALLOW');
    else finish('DENY', r?.interrupt ? { terminal_reason: 'aborted_tools' } : {});
  }
}
