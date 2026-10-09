import test from 'node:test';
import assert from 'node:assert/strict';
import { readCodexMcpApproval, readCodexMcpElicitation } from '../dist/codex-mcp-approval.js';

const item = { type: 'mcpToolCall', id: 'call-1', status: 'inProgress', server: 'fixture', tool: 'write', arguments: { file: 'sample.txt' } };
const options = ['Allow', 'Allow for this session', "Allow and don't ask me again", 'Cancel'].map(label => ({ label, description: label }));
const question = { id: 'mcp_tool_call_approval_call-1', header: 'Approve app tool call?', question: 'Allow this exact call?', isOther: false, isSecret: false, options };

test('MCP approval decoder binds the reserved question ID to a live reviewable native call', () => {
  for (const offered of [options, [options[0], options[3]], [options[0], options[1], options[3]]]) {
    const decoded = readCodexMcpApproval([{ ...question, options: offered }], item);
    assert.equal(decoded.questionId, question.id);
    assert.match(decoded.message, /sample\.txt/); assert.match(decoded.message, /"server": "fixture"/);
    assert.match(decoded.message, /"tool": "write"/); assert.match(decoded.message, /persistent grants are not supported/);
  }
  assert.ok(readCodexMcpApproval([{ ...question, isOther: undefined, isSecret: undefined }], item),
    "native schema defaults omitted flags to false");
  const strange = { ...item, id: '__proto__', arguments: null };
  assert.equal(readCodexMcpApproval([{ ...question, id: 'mcp_tool_call_approval___proto__' }], strange).questionId,
    'mcp_tool_call_approval___proto__');
});

test('MCP decoder rejects ordinary, mixed, ambiguous and custom-answer forms', () => {
  for (const input of [undefined, null, {}, [], [question, question],
    ...[{ id: 'ordinary' }, { id: `${question.id}-other` }, { header: null }, { question: '' },
      { isOther: true }, { isOther: null }, { isOther: "false" }, { isSecret: true }, { isSecret: null }, { multiSelect: true }, { options: null },
      { options: [options[0]] }, { options: [options[3]] }, { options: [...options, options[0]] },
      { options: [...options, { label: 'Allow everything', description: 'Not the native contract' }] },
      { options: [{ label: 'Allow' }, options[3]] }, { question: 'x'.repeat(12_000) },
    ].map(patch => [{ ...question, ...patch }]),
  ]) assert.equal(readCodexMcpApproval(input, item), undefined);
});

const elicitation = { mode: 'form', serverName: 'fixture', message: 'Allow the MCP tool?',
  _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] }, requestedSchema: { type: 'object', properties: {} } };

test('MCP elicitation recognizes only marked message-only forms and native optional schema defaults', () => {
  for (const mode of ['form', 'openai/form', 'openaiForm'])
    for (const requestedSchema of [null, elicitation.requestedSchema, { ...elicitation.requestedSchema, required: null, $schema: null },
      { ...elicitation.requestedSchema, required: [], $schema: 'https://json-schema.org/draft-07/schema#' }]) {
      const result = readCodexMcpElicitation({ ...elicitation, mode, requestedSchema }, item);
      assert.ok(result); assert.match(result.message, /sample\.txt/); assert.match(result.message, /persistent grants are not supported/);
    }
});

test('MCP elicitation rejects other meta kinds, data, URL, ambiguous schema and action shapes', () => {
  for (const input of [null, [], {}, ...[{ _meta: undefined }, { _meta: { codex_approval_kind: 'tool_suggestion' } },
    { _meta: { codex_approval_kind: 'other' } }, { mode: 'url' }, { mode: 'openai/url' }, { mode: 'openai/userVerification' }, { mode: 'unknown' },
    { serverName: 'foreign' }, { message: '' }, { message: 'x'.repeat(12_000) }, { requestedSchema: undefined },
    ...[{}, [], { type: 'object' }, { type: 'object', properties: [] },
      { ...elicitation.requestedSchema, properties: { field: { type: 'string' } } },
      { ...elicitation.requestedSchema, required: ['hidden'] }, { ...elicitation.requestedSchema, required: false },
      { ...elicitation.requestedSchema, $schema: 42 }, { ...elicitation.requestedSchema, anyOf: [] },
    ].map(requestedSchema => ({ requestedSchema })),
  ].map(patch => ({ ...elicitation, ...patch }))]) assert.equal(readCodexMcpElicitation(input, item), undefined);
  for (const action of [null, [], {}, ...[{ status: 'completed' }, { server: '' }, { tool: '' }, { id: '' },
    { arguments: undefined }, { type: 'commandExecution' }].map(patch => ({ ...item, ...patch }))])
    assert.equal(readCodexMcpElicitation(elicitation, action), undefined);
});

test('MCP decoder rejects missing, foreign-kind, ended or unreviewable action items', () => {
  for (const input of [null, [], {}, ...[{ type: 'commandExecution' }, { id: 'other' }, { status: 'completed' },
    { server: '' }, { tool: '' }, { arguments: undefined }, { arguments: 'x'.repeat(12_000) },
  ].map(patch => ({ ...item, ...patch }))]) assert.equal(readCodexMcpApproval([question], input), undefined);
  assert.equal(readCodexMcpApproval([{ ...question, id: 'mcp_tool_call_approval_' }], { ...item, id: '' }), undefined);
});
