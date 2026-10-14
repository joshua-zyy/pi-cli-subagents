// Deterministic app-server fixture. All storage is confined to the injected test home.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const home = process.env.CODEX_HOME;
if (!home || !fs.existsSync(path.join(home, 'fixture-home'))) throw Error('An explicit fixture home is required');
if (process.argv.includes('--exit-when-idle')) setInterval(() => { if (fs.existsSync(path.join(home, 'exit-idle'))) process.exit(0); }, 10);
const emit = record => process.stdout.write(JSON.stringify(record) + '\n');
const response = (cmd, result = {}) => emit({ id: cmd.id, result });
const error = (cmd, message) => emit({ id: cmd.id, error: { code: -32000, message } });
const notify = (method, params) => emit({ method, params });
let initialized = false, acknowledged = false, thread, turn, buffer = '';
const approvals = new Map();
const questions = new Map();
const elicitations = new Map();
const file = id => path.join(home, `${id}.json`);
const save = () => fs.writeFileSync(file(thread.id), JSON.stringify(thread));
function item(text, id = 'answer') {
  return { type: 'agentMessage', id, text, phase: process.argv.includes('--no-final-phase') ? null : 'final_answer' };
}
function asyncMessage() {
  return { type: 'agentMessage', id: 'async-ask', text: 'Please supply task context.', phase: 'final_answer', delivery: 'async',
    questions: [{ title: 'Which check?', options: ['Unit', 'Integration'] }, { title: 'What context is missing?', options: null }] };
}
function finish(text, status = 'completed', mode = '') {
  turn.status = status;
  thread.status = { type: 'idle' };
  turn.items = [...turn.items.filter(i => i.type === 'userMessage'), ...(text === null ? [] : [item(text)])];
  if (status === 'failed') turn.error = { message: 'fixture model failure' };
  thread.turns.push(structuredClone(turn)); save();
  if (text !== null && mode !== 'BACKFILL') {
    notify('item/agentMessage/delta', { threadId: thread.id, turnId: turn.id, itemId: 'answer', delta: text.slice(0, 1) });
    notify('item/agentMessage/delta', { threadId: thread.id, turnId: turn.id, itemId: 'answer', delta: text.slice(1) });
    notify('item/completed', { threadId: thread.id, turnId: turn.id, item: item(text) });
  }
  if (mode === 'ASYNC_REPLY') notify('item/completed', { threadId: thread.id, turnId: turn.id, item: asyncMessage() });
  notify('turn/completed', { threadId: thread.id, turn: { ...turn, items: [], itemsView: 'summary' } });
}
function execute(message) {
  // Retain the full baseline notice in requests and native items; only dispatch the fixture task.
  message = message.split('\n\n[Workspace baseline]\n')[0];
  if (message === 'CWD') return finish(process.cwd());
  if (message.startsWith('FILE ')) {
    const { file, content } = JSON.parse(message.slice(5));
    const target = path.resolve(file), relative = path.relative(process.cwd(), target);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw Error('Fixture files must stay in cwd');
    if (content !== undefined) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); }
    return finish(fs.readFileSync(target, 'utf8'));
  }
  if (message.startsWith('ASYNC_QUESTION')) {
    notify('item/completed', { threadId: thread.id, turnId: turn.id, item: asyncMessage() });
    if (message.includes('DUPLICATE')) notify('item/completed', { threadId: thread.id, turnId: turn.id, item: asyncMessage() });
    if (message.includes('TURN_END')) finish('TURN-ENDED');
    return;
  }
  if (message.startsWith('Answers to your questions:\n\n')) return finish(message, 'completed', 'ASYNC_REPLY');
  if (message.startsWith('HOLD')) return;
  if (message === 'CRASH') return process.exit(2);
  if (message === 'NOISE') return process.stdout.write('not-json\n');
  if (message === 'EARLY_EXIT') return process.exit(0);
  if (message === 'DEFAULT_QUESTION') {
    const setting = process.argv.filter(arg => arg.startsWith('features.default_mode_request_user_input=')).at(-1);
    return setting === 'features.default_mode_request_user_input=true' ? execute('QUESTION') : finish('DEFAULT_QUESTIONS_DISABLED');
  }
  if (message.startsWith('MCP_ELICIT')) {
    const id = message.includes('STRING_ID') ? '37' : 37;
    const nativeItem = { type: 'mcpToolCall', id: 'mcp-call', server: 'fixture', tool: 'write', arguments: { file: 'elicitation-only.txt' }, status: 'inProgress' };
    if (!message.includes('MISSING_ITEM')) notify('item/started', { threadId: thread.id, turnId: turn.id, item: nativeItem });
    if (message.includes('COMPLETED_ITEM')) notify('item/completed', { threadId: thread.id, turnId: turn.id, item: { ...nativeItem, status: 'completed' } });
    if (message.includes('AMBIGUOUS') || message.includes('OTHER_DONE') || message.includes('OTHER_SERVER')) {
      const other = { ...nativeItem, id: 'other', server: message.includes('OTHER_SERVER') ? 'other-server' : 'fixture' };
      notify('item/started', { threadId: thread.id, turnId: turn.id, item: other });
      if (message.includes('OTHER_DONE')) notify('item/completed', { threadId: thread.id, turnId: turn.id, item: { ...other, status: 'completed' } });
    }
    elicitations.set(`${typeof id}:${id}`, { id });
    emit({ id, method: 'mcpServer/elicitation/request', params: {
      threadId: message.includes('WRONG_THREAD') ? 'foreign' : thread.id,
      turnId: message.includes('NULL_TURN') ? null : message.includes('WRONG_TURN') ? 'old' : turn.id,
      serverName: message.includes('WRONG_SERVER') ? 'foreign' : 'fixture',
      mode: message.includes('URL') ? 'url' : message.includes('LEGACY') ? 'openai/form' : 'form',
      message: 'Allow the fixture MCP action?',
      _meta: message.includes('NO_META') ? null : { codex_approval_kind: message.includes('SUGGESTION') ? 'tool_suggestion' : 'mcp_tool_call', persist: ['session', 'always'] },
      requestedSchema: message.includes('DATA_FORM') ? { type: 'object', properties: { name: { type: 'string' } } } : { type: 'object', properties: {} },
    } });
    if (message.includes('AUTO_RESOLVE')) setTimeout(() => {
      notify('serverRequest/resolved', { threadId: thread.id, requestId: id }); elicitations.delete(`${typeof id}:${id}`); finish('AUTO-RESOLVED');
    }, 80);
    if (message.includes('TURN_END')) finish('TURN-ENDED');
    return;
  }
  if (message.startsWith('MCP_APPROVAL')) {
    const id = message.includes('STRING_ID') ? '17' : 17, itemId = 'mcp-call';
    const nativeItem = { type: 'mcpToolCall', id: itemId, server: 'fixture', tool: 'write', arguments: { file: 'fixture-only.txt' }, status: 'inProgress' };
    const itemTurn = message.includes('OLD_ITEM') ? 'old-turn' : turn.id;
    if (message.includes('OLD_ITEM')) notify('turn/started', { threadId: thread.id, turn: { id: itemTurn } });
    if (!message.includes('MISSING_ITEM')) notify('item/started', { threadId: thread.id, turnId: itemTurn, item: nativeItem });
    if (message.includes('OLD_ITEM')) notify('turn/started', { threadId: thread.id, turn: { id: turn.id } });
    if (message.includes('COMPLETED_ITEM')) notify('item/completed', { threadId: thread.id, turnId: turn.id, item: { ...nativeItem, status: 'completed' } });
    const questionId = `mcp_tool_call_approval_${message.includes('WRONG_KEY') ? 'other' : itemId}`;
    questions.set(`${typeof id}:${id}`, { id, itemId, turnId: turn.id, mcpQuestionId: questionId });
    emit({ id, method: message.includes('LEGACY') ? 'tool/requestUserInput' : 'item/tool/requestUserInput', params: {
      threadId: message.includes('WRONG_THREAD') ? 'foreign' : thread.id,
      turnId: message.includes('WRONG_TURN') ? 'old-turn' : turn.id,
      itemId: message.includes('WRONG_ITEM') ? 'other' : itemId, isBlocking: !message.includes('NONBLOCKING'),
      questions: [{ id: questionId, header: 'Approve app tool call?', question: 'Allow the fixture MCP write?',
        isOther: message.includes('OMITTED_FLAGS') ? undefined : false, isSecret: message.includes('OMITTED_FLAGS') ? undefined : false,
        options: ['Allow', 'Allow for this session', "Allow and don't ask me again", 'Cancel'].map(label => ({ label, description: label })) }],
    } });
    if (message.includes('AUTO_RESOLVE')) setTimeout(() => {
      notify('serverRequest/resolved', { threadId: thread.id, requestId: id }); questions.delete(`${typeof id}:${id}`); finish('AUTO-RESOLVED');
    }, 80);
    if (message.includes('TURN_END')) finish('TURN-ENDED');
    return;
  }
  if (message.startsWith('QUESTION')) {
    const id = message.includes('STRING_ID') ? '17' : 17;
    const request = { id, itemId: 'ask', turnId: turn.id };
    questions.set(`${typeof id}:${id}`, request);
    if (message.includes('MCP_ITEM')) notify('item/started', { threadId: thread.id, turnId: turn.id,
      item: { type: 'mcpToolCall', id: 'ask', server: 'fixture', tool: 'write', arguments: {}, status: 'inProgress' } });
    emit({ id, method: 'item/tool/requestUserInput', params: {
      threadId: thread.id, turnId: turn.id, itemId: 'ask', isBlocking: !message.includes('NONBLOCKING'), autoResolutionMs: 0,
      questions: message.includes('MCP_APPROVAL') ? [
        { id: 'mcp_tool_call_approval_ask', header: 'Approve app tool call?', question: 'Allow this MCP action?', isOther: false, isSecret: false,
          options: [
            { label: 'Allow', description: 'Run once' },
            { label: 'Allow for this session', description: 'Remember this session' },
            { label: "Allow and don't ask me again", description: 'Persist a policy amendment' },
            { label: 'Cancel', description: 'Cancel this action' },
          ] },
      ] : [
        { id: 'checks', header: 'Tests', question: 'Which checks should run?', isOther: false, isSecret: false,
          options: [{ label: 'Unit', description: 'Focused checks' }, { label: 'Integration', description: 'Local scenario' }] },
        { id: 'context', header: 'Context', question: 'What task context is missing?', options: null, isOther: true, isSecret: false },
      ],
    } });
    if (message.includes('AUTO_RESOLVE')) setTimeout(() => {
      notify('serverRequest/resolved', { threadId: thread.id, requestId: id }); questions.delete(`${typeof id}:${id}`);
      finish('AUTO-RESOLVED');
    }, 80);
    if (message.includes('TURN_END')) finish('TURN-ENDED');
    return;
  }
  if (message.startsWith('APPROVAL')) {
    const fileChange = message.includes('FILE');
    const kind = fileChange ? 'fileChange' : 'commandExecution';
    const itemId = fileChange ? 'patch' : 'cmd';
    if (!message.includes('NO_DETAILS')) notify('item/started', { threadId: thread.id, turnId: turn.id,
      item: fileChange ? { type: kind, id: itemId, status: 'inProgress', changes: [{ path: path.join(home, 'work.txt'), kind: { type: 'update', move_path: message.includes('MOVE') ? path.join(home, 'renamed.txt') : null }, diff: '+one line' }] } :
        { type: kind, id: itemId, status: 'inProgress', command: 'write fixture-only', cwd: process.cwd() } });
    const count = message.includes('DOUBLE') ? 2 : 1;
    for (let n = 0; n < count; n++) {
      const id = message.includes('STRING_ID') ? `request-${n}` : 17 + n;
      approvals.set(`${typeof id}:${id}`, { id, itemId, turnId: turn.id, decision: undefined, expected: count });
      emit({ id, method: fileChange ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval',
        params: { threadId: message.includes('WRONG_SCOPE') ? 'foreign' : thread.id, turnId: turn.id, itemId,
          startedAtMs: Date.now(), reason: 'Only the fixture action',
          ...(fileChange ? { grantRoot: message.includes('GRANT_ROOT') ? home : null } :
            { command: message.includes('NO_DETAILS') ? null : 'write fixture-only', cwd: process.cwd(), kind: message.includes('WRITE_STDIN') ? 'writeStdin' : 'command',
              ...(message.includes('EXTRA_PERMISSIONS') ? { additionalPermissions: { fileSystem: { write: [home] } } } : {}),
              ...(message.includes('NETWORK') ? { networkApprovalContext: { host: 'example.test' } } : {}),
              ...(message.includes('ONLY_SESSION') ? { availableDecisions: ['acceptForSession', 'decline'] } : {}),
              ...(message.includes('NO_CANCEL') ? { availableDecisions: ['accept', 'decline'] } : {}),
              ...(message.includes('ACCEPT_CANCEL') ? { availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['fixture-only'] } }, 'cancel'] } : {}) }) } });
      if (message.includes('AUTO_RESOLVE')) setTimeout(() => {
        notify('serverRequest/resolved', { threadId: thread.id, requestId: id }); approvals.delete(`${typeof id}:${id}`);
        if (!approvals.size) finish('AUTO-RESOLVED');
      }, 80);
    }
    return;
  }
  if (message === 'TRANSCRIPT') {
    notify('item/started', { threadId: thread.id, turnId: turn.id,
      item: { type: 'commandExecution', id: 'shell-transcript', command: 'echo demo', cwd: process.cwd(), status: 'inProgress' } });
    notify('item/commandExecution/outputDelta', { threadId: thread.id, turnId: turn.id, itemId: 'shell-transcript', delta: 'demo\\n' });
    notify('item/completed', { threadId: thread.id, turnId: turn.id,
      item: { type: 'commandExecution', id: 'shell-transcript', command: 'echo demo', cwd: process.cwd(), status: 'completed', aggregatedOutput: 'demo\\n' } });
    notify('thread/tokenUsage/updated', { threadId: thread.id, turnId: turn.id, tokenUsage: {
      last: { inputTokens: 100, cachedInputTokens: 30, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 105 },
      total: { inputTokens: 100, cachedInputTokens: 30, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 105 }, modelContextWindow: 2000 } });
    return finish('TRANSCRIPT-OK');
  }
  if (message === 'COMMENTARY') {
    // Real turns open a reasoning item, then the message item, before the deltas arrive.
    notify('item/started', { threadId: thread.id, turnId: turn.id,
      item: { type: 'reasoning', id: 'reason-1', summary: [], content: [] } });
    notify('item/completed', { threadId: thread.id, turnId: turn.id,
      item: { type: 'reasoning', id: 'reason-1', summary: [], content: [] } });
    notify('item/started', { threadId: thread.id, turnId: turn.id,
      item: { type: 'agentMessage', id: 'progress', text: '', phase: 'commentary' } });
    notify('item/agentMessage/delta', { threadId: thread.id, turnId: turn.id, itemId: 'progress', delta: 'Working...' });
    notify('item/completed', { threadId: thread.id, turnId: turn.id, item: { type: 'agentMessage', id: 'progress', text: 'Working...', phase: 'commentary' } });
    return finish('FINAL');
  }
  if (message === 'FOREIGN_EVENTS') {
    notify('turn/completed', { threadId: 'another-thread', turn: { id: turn.id, status: 'completed', items: [item('WRONG')] } });
    notify('turn/completed', { threadId: thread.id, turn: { id: 'previous-turn', status: 'completed', items: [item('WRONG')] } });
    return finish('CURRENT');
  }
  if (message.startsWith('REMEMBER ')) { thread.token = message.slice(9); save(); return finish('OK'); }
  if (message === 'RECALL') return finish(thread.token ?? 'MISSING');
  if (message === 'FAIL') return finish(null, 'failed');
  if (message === 'EMPTY') return finish(null);
  if (message === 'BACKFILL') return finish('RECOVERED', 'completed', 'BACKFILL');
  if (message === 'UNICODE') return finish('A\u2028B\u2029雪');
  finish(message);
}
function handle(cmd) {
  fs.appendFileSync(path.join(home, 'requests.jsonl'), JSON.stringify({ ...cmd, pid: process.pid, cwd: process.cwd(), ...(cmd.method === 'initialize' ? { launchArgs: process.argv.slice(2) } : {}) }) + '\n');
  if (!cmd.method) {
    const key = `${typeof cmd.id}:${cmd.id}`, question = questions.get(key), elicitation = elicitations.get(key);
    if (elicitation) {
      if (cmd.error) { elicitations.delete(key); return; }
      const result = cmd.result;
      if (!result || !['accept', 'decline', 'cancel'].includes(result.action)) throw Error('Malformed native MCP elicitation response');
      if (result.action === 'accept') {
        const effect = path.join(home, 'elicitation-effect.txt');
        fs.writeFileSync(effect, String((fs.existsSync(effect) ? Number(fs.readFileSync(effect, 'utf8')) : 0) + 1));
        if (result._meta?.persist) fs.appendFileSync(path.join(home, 'elicitation-grants.jsonl'), JSON.stringify(result._meta) + '\n');
      }
      if (!process.argv.includes('--no-resolved')) {
        notify('serverRequest/resolved', { threadId: thread.id, requestId: elicitation.id }); elicitations.delete(key);
        finish(`ELICITATION:${result.action}`, result.action === 'cancel' ? 'interrupted' : 'completed');
      }
      return;
    }
    if (question) {
      if (cmd.error) { questions.delete(key); return; }
      const answers = cmd.result?.answers;
      if (question.mcpQuestionId) {
        const selected = answers?.[question.mcpQuestionId]?.answers;
        // Native parse_mcp_tool_approval_response treats a missing answer as ReviewDecision::Abort, i.e. Cancel.
        const empty = answers && typeof answers === 'object' && !Array.isArray(answers) && Object.keys(answers).length === 0 && Object.keys(cmd.result).length === 1;
        if (!empty && (!answers || Object.keys(cmd.result).length !== 1 || Object.keys(answers).length !== 1 ||
          !Array.isArray(selected) || selected.length !== 1 || !['Allow', 'Allow for this session', "Allow and don't ask me again", 'Cancel'].includes(selected[0]))) throw Error('Malformed native MCP approval answer');
        const decision = empty ? 'Cancel' : selected[0];
        if (decision !== 'Cancel') {
          const effect = path.join(home, 'mcp-effect.txt');
          fs.writeFileSync(effect, String((fs.existsSync(effect) ? Number(fs.readFileSync(effect, 'utf8')) : 0) + 1));
          if (decision !== 'Allow') fs.appendFileSync(path.join(home, 'mcp-grants.jsonl'), JSON.stringify(decision) + '\n');
        }
        if (!process.argv.includes('--no-resolved')) {
          notify('serverRequest/resolved', { threadId: thread.id, requestId: question.id }); questions.delete(key);
          finish(`MCP:${decision}`, decision === 'Cancel' ? 'interrupted' : 'completed');
        }
        return;
      }
      if (!answers || typeof answers !== 'object' || Array.isArray(answers) ||
        Object.entries(answers).some(([id, value]) => !['checks','context'].includes(id) ||
          !Array.isArray(value?.answers) || value.answers.some(answer => typeof answer !== 'string')) ||
        Object.keys(cmd.result).some(key => key !== 'answers')) throw Error('Malformed native question answer');
      if (!process.argv.includes('--no-resolved')) {
        notify('serverRequest/resolved', { threadId: thread.id, requestId: question.id }); questions.delete(key);
        finish(JSON.stringify(answers));
      }
      return;
    }
    const approval = approvals.get(key);
    if (!approval) return;
    if (cmd.result?.decision) {
      approval.decision = cmd.result.decision;
      if (!['accept','decline','cancel'].includes(approval.decision)) throw Error('Only one-action decisions are allowed');
    } else approval.decision = 'error';
    if (!process.argv.includes('--no-resolved')) {
      notify('serverRequest/resolved', { threadId: thread.id, requestId: approval.id }); approvals.delete(key);
    }
    if (!process.argv.includes('--no-resolved') && ![...approvals.values()].some(a => a.decision === undefined)) {
      notify('item/completed', { threadId: thread.id, turnId: turn.id,
        item: { type: approval.itemId === 'patch' ? 'fileChange' : 'commandExecution', id: approval.itemId,
          status: approval.decision === 'accept' ? 'completed' : 'declined', command: 'write fixture-only', cwd: process.cwd(), aggregatedOutput: '' } });
      finish(approval.decision === 'accept' ? 'ALLOW' : approval.decision === 'decline' ? 'DENY' : approval.decision === 'cancel' ? 'CANCELLED' : 'UNSUPPORTED', approval.decision === 'cancel' ? 'interrupted' : 'completed');
    }
    return;
  }
  if (cmd.method === 'initialize') { initialized = true; return response(cmd, { userAgent: 'fixture/0.159.2' }); }
  if (cmd.method === 'initialized') { if (!initialized) throw Error('missing initialize'); acknowledged = true; return; }
  if (!acknowledged) return error(cmd, 'Not initialized');
  if (cmd.method === 'thread/start') {
    // An omitted model inherits the native default, as config.toml would supply it.
    thread = { id: randomUUID(), sessionId: randomUUID(), path: null, cwd: cmd.params.cwd, ephemeral: false, status: { type: 'idle' }, turns: [], model: cmd.params.model ?? 'fixture-default-model' };
    save();
    if (process.argv.includes('--hold-ready')) {
      const timer = setInterval(() => { if (fs.existsSync(path.join(home, 'release-ready'))) {
        clearInterval(timer); response(cmd, { thread, model: thread.model, cwd: thread.cwd });
      } }, 10);
      return;
    }
    return response(cmd, { thread, model: thread.model, cwd: thread.cwd });
  }
  if (cmd.method === 'thread/resume' || cmd.method === 'thread/read') {
    if (cmd.method === 'thread/resume' && process.argv.includes('--reject-resume')) return error(cmd, 'Fixture resume rejected after preflight');
    if (cmd.method === 'thread/read' && process.argv.includes('--read-timeout')) return;
    if (!fs.existsSync(file(cmd.params.threadId))) return error(cmd, 'Original thread missing');
    thread = JSON.parse(fs.readFileSync(file(cmd.params.threadId), 'utf8'));
    const result = structuredClone(thread);
    if (process.argv.includes('--wrong-resume') && cmd.method === 'thread/resume') result.id = randomUUID();
    if (process.argv.includes('--wrong-session') && cmd.method === 'thread/resume') result.sessionId = randomUUID();
    if (process.argv.includes('--wrong-read') && cmd.method === 'thread/read') result.id = randomUUID();
    if (cmd.method === 'thread/read' && !cmd.params.includeTurns) result.turns = [];
    const reply = () => response(cmd, { thread: result, model: cmd.params.model ?? thread.model, cwd: thread.cwd });
    if (cmd.method === 'thread/read' && process.argv.includes('--hold-read')) {
      const timer = setInterval(() => {
        if (fs.existsSync(path.join(home, 'release-read'))) { clearInterval(timer); reply(); }
      }, 10);
      return;
    }
    return reply();
  }
  if (cmd.method === 'fixture/emit') { for (const record of cmd.params.records) emit(record); return; }
  if (cmd.method === 'fixture/mcpItemUpdate') {
    notify('item/completed', { threadId: thread.id, turnId: turn.id,
      item: { type: 'mcpToolCall', id: 'mcp-call', status: 'completed', server: 'fixture', tool: 'write', arguments: {} } });
    return;
  }
  if (cmd.method === 'fixture/approvalScope') {
    if ('activeTurnId' in cmd.params) notify('turn/started', { threadId: thread.id, turn: { id: cmd.params.activeTurnId } });
    emit({ id: 17, method: 'item/commandExecution/requestApproval', params: {
      threadId: thread.id, turnId: cmd.params.turnId, itemId: 'cmd', command: 'fixture-only', cwd: process.cwd(),
    } });
    return;
  }
  if (cmd.method === 'turn/start') {
    if (cmd.params.threadId !== thread.id) return error(cmd, 'Wrong thread');
    const message = cmd.params.input[0].text;
    if (message === 'REJECT') return error(cmd, 'fixture rejected submission');
    turn = { id: randomUUID(), status: 'inProgress', items: [{ type: 'userMessage', id: 'user', content: cmd.params.input }] };
    thread.status = { type: 'active', activeFlags: [] }; save();
    // Emit events before the response to exercise notification/response interleaving.
    notify('turn/started', { threadId: thread.id, turn: structuredClone(turn) });
    if (message === 'TIMEOUT') return;
    const initial = structuredClone(turn);
    notify('item/completed', { threadId: thread.id, turnId: turn.id,
      item: { type: 'userMessage', id: `user-${turn.id}`, content: [{ type: 'text', text: message }] } });
    execute(message);
    if (process.argv.includes('--delay-start')) return setTimeout(() => response(cmd, { turn: initial }), 100);
    return response(cmd, { turn: initial });
  }
  if (cmd.method === 'turn/steer') {
    if (process.argv.includes('--no-steer-response')) return;
    if (cmd.params.threadId !== thread.id || cmd.params.expectedTurnId !== turn.id) return error(cmd, 'Wrong active turn');
    const message = cmd.params.input[0].text;
    if (message === 'FAST_STEER') { finish('FAST_STEER'); response(cmd, { turnId: turn.id }); }
    else { response(cmd, { turnId: turn.id }); execute(message); }
    return;
  }
  if (cmd.method === 'turn/interrupt') {
    if (process.argv.includes('--ignore-interrupt')) return;
    if (cmd.params.threadId !== thread.id || cmd.params.turnId !== turn.id) return error(cmd, 'Wrong interrupt target');
    response(cmd);
    if (process.argv.includes('--ack-interrupt-only')) return;
    approvals.clear(); questions.clear(); elicitations.clear();
    // The response is not completion. A client must wait for the terminal event.
    setTimeout(() => finish('INTERRUPTED', 'interrupted'), 60);
    return;
  }
  error(cmd, `Unsupported method: ${cmd.method}`);
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
