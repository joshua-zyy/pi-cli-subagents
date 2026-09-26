// Deterministic RPC fixture: no model/network/configuration access.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const flag = (name) => process.argv[process.argv.indexOf(name) + 1];
const sessionFile = process.argv.includes('--session') ? flag('--session') : path.join(flag('--session-dir'), 'fake-session.json');
fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
const session = fs.existsSync(sessionFile) ? JSON.parse(fs.readFileSync(sessionFile, 'utf8')) : { sessionId: randomUUID(), messages: [] };
const save = () => fs.writeFileSync(sessionFile, JSON.stringify(session));
let active = false, buffer = '', question = false, settling;
const emit = (record) => process.stdout.write(JSON.stringify(record) + '\n');
const response = (cmd, data = {}) => emit({ type: 'response', id: cmd.id, command: cmd.type, success: true, data });
function finish(text, stopReason = 'stop') {
  const message = { role: 'assistant', content: [{ type: 'text', text }], stopReason };
  session.messages.push(message); save();
  emit({ type: 'message_end', message }); emit({ type: 'agent_end' });
  clearTimeout(settling);
  settling = setTimeout(() => { active = false; emit({ type: 'agent_settled' }); }, 100);
}
function handle(cmd) {
  if (cmd.type === 'get_state') return response(cmd, { sessionId: session.sessionId, sessionFile, isStreaming: active });
  if (cmd.type === 'get_messages') return response(cmd, { messages: session.messages });
  if (cmd.type === 'clear_queue') return response(cmd);
  if (cmd.type === 'abort') { clearTimeout(settling); active = false; finish('ABORTED', 'aborted'); return response(cmd); }
  if (cmd.type === 'extension_ui_response') {
    if (!question || cmd.id !== 'permission-1') throw new Error('wrong UI response');
    question = false; return finish(cmd.confirmed ? 'ALLOW' : 'DENY');
  }
  if (cmd.type !== 'prompt') return emit({ type: 'response', id: cmd.id, success: false, error: 'unsupported command' });
  if (cmd.message === 'REJECT') return emit({ type: 'response', id: cmd.id, success: false, error: 'rejected by fixture' });
  if (active && !cmd.streamingBehavior) return emit({ type: 'response', id: cmd.id, success: false, error: 'already running' });
  session.messages.push({ role: 'user', content: cmd.message }); save();
  active = true; response(cmd); emit({ type: 'agent_start' });
  if (cmd.message.startsWith('HOLD')) return;
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
  if (cmd.message === 'WAIT') {
    question = true;
    emit({ type: 'extension_ui_request', id: 'permission-1', method: 'confirm', title: 'Allow fixture operation?', message: 'Requires a human answer' });
    return;
  }
  if (cmd.message === 'FAIL') return finish('', 'error');
  if (cmd.message === 'CRASH') return process.exit(2);
  if (cmd.message.startsWith('REMEMBER ')) { session.token = cmd.message.slice(9); save(); return finish('OK'); }
  if (cmd.message === 'RECALL') return finish(session.token ?? 'MISSING');
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
process.stdin.on('end', () => { clearTimeout(settling); });
