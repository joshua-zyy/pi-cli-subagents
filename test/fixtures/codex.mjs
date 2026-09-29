// Deterministic app-server fixture. All storage is confined to the injected test home.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const home = process.env.CODEX_HOME;
if (!home || !fs.existsSync(path.join(home, 'fixture-home'))) throw Error('An explicit fixture home is required');
const emit = record => process.stdout.write(JSON.stringify(record) + '\n');
const response = (cmd, result = {}) => emit({ id: cmd.id, result });
const error = (cmd, message) => emit({ id: cmd.id, error: { code: -32000, message } });
const notify = (method, params) => emit({ method, params });
let initialized = false, acknowledged = false, thread, turn, buffer = '';
const approvals = new Map();
const file = id => path.join(home, `${id}.json`);
const save = () => fs.writeFileSync(file(thread.id), JSON.stringify(thread));
function item(text, id = 'answer') {
  return { type: 'agentMessage', id, text, phase: 'final_answer' };
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
  if (message.startsWith('HOLD')) return;
  if (message === 'CRASH') return process.exit(2);
  if (message === 'NOISE') return process.stdout.write('not-json\n');
  if (message === 'EARLY_EXIT') return process.exit(0);
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
  fs.appendFileSync(path.join(home, 'requests.jsonl'), JSON.stringify({ ...cmd, pid: process.pid, cwd: process.cwd() }) + '\n');
  if (!cmd.method) {
    const key = `${typeof cmd.id}:${cmd.id}`, approval = approvals.get(key);
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
  if (cmd.method === 'initialize') { initialized = true; return response(cmd, { userAgent: 'fixture/0.154.0' }); }
  if (cmd.method === 'initialized') { if (!initialized) throw Error('missing initialize'); acknowledged = true; return; }
  if (!acknowledged) return error(cmd, 'Not initialized');
  if (cmd.method === 'thread/start') {
    if (!cmd.params.model) return error(cmd, 'Explicit model required');
    thread = { id: randomUUID(), sessionId: randomUUID(), path: null, cwd: cmd.params.cwd, ephemeral: false, status: { type: 'idle' }, turns: [], model: cmd.params.model };
    save();
    return response(cmd, { thread, model: cmd.params.model, cwd: thread.cwd });
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
    return response(cmd, { turn: initial });
  }
  if (cmd.method === 'turn/steer') {
    if (cmd.params.threadId !== thread.id || cmd.params.expectedTurnId !== turn.id) return error(cmd, 'Wrong active turn');
    const message = cmd.params.input[0].text;
    if (message === 'FAST_STEER') { finish('FAST_STEER'); response(cmd, { turnId: turn.id }); }
    else { response(cmd, { turnId: turn.id }); execute(message); }
    return;
  }
  if (cmd.method === 'turn/interrupt') {
    if (cmd.params.threadId !== thread.id || cmd.params.turnId !== turn.id) return error(cmd, 'Wrong interrupt target');
    response(cmd);
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
