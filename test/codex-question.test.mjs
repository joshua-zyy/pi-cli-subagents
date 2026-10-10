import test from 'node:test';
import assert from 'node:assert/strict';
import * as questionContract from '../dist/codex-question.js';
const { readCodexQuestionFields, readCodexAsyncQuestionFields, validateQuestionAnswers } = questionContract;

test('Codex async messages become complete, single-answer forms without inventing native request IDs', () => {
  assert.equal(typeof readCodexAsyncQuestionFields, 'function');
  const fields = readCodexAsyncQuestionFields({ type: 'agentMessage', id: 'native-item', delivery: 'async',
    questions: [{ title: 'Which check?', options: ['Unit', 'Integration'] }, { title: 'Context?', options: null }] });
  assert.deepEqual(fields, [
    { id: '0', header: 'Question 1', question: 'Which check?', options: [{ label: 'Unit', description: '' }, { label: 'Integration', description: '' }], allowOther: true, isSecret: false, multiSelect: false, required: true },
    { id: '1', header: 'Question 2', question: 'Context?', options: [], allowOther: true, isSecret: false, multiSelect: false, required: true },
  ]);
  const answers = { '0': ['custom choice'], '1': ['literal, 雪\nanswer'] };
  assert.deepEqual(validateQuestionAnswers(fields, answers), answers);
  for (const values of [[], [' '], ['Unit', 'Integration']])
    assert.throws(() => validateQuestionAnswers(fields, { ...answers, '0': values }), /required|one answer/i);
  for (const patch of [{ delivery: null }, { type: 'mcpToolCall' }, { id: '' }, { questions: [] },
    { questions: [{ title: '', options: null }] }, { questions: [{ title: 'Context?', options: 'Unit' }] },
    { questions: [{ title: 'Context?', options: [1] }] }])
    assert.equal(readCodexAsyncQuestionFields({ type: 'agentMessage', id: 'native-item', delivery: 'async', questions: [{ title: 'Context?', options: null }], ...patch }), undefined);
});

const questions = [
  { id: ' checks ', header: 'Context', question: 'Which check?', options: [{ label: 'Unit, fast', description: 'Exact punctuation' }] },
  { id: 'context', header: 'Context', question: 'What is missing?', options: null, isSecret: true },
];

test('Codex normalization retains field identity, duplicate headers, choices and sensitive metadata', () => {
  assert.deepEqual(readCodexQuestionFields(questions), [
    { ...questions[0], allowOther: false, isSecret: false },
    { ...questions[1], options: [], allowOther: true },
  ]);
  assert.equal(readCodexQuestionFields([{ ...questions[0], isOther: true }])[0].allowOther, true);
});

test('Codex incomplete or ambiguous forms are not silently narrowed into answerable questions', () => {
  for (const input of [null, {}, [], [questions[0], questions[0]],
    ...[{ id: '' }, { header: ' ' }, { question: null }, { isOther: 'true' }, { isSecret: 'false' },
      { multiSelect: true }, { options: {} }, { options: [{ label: 'x' }] },
      { options: [questions[0].options[0], questions[0].options[0]] }].map(patch => [{ ...questions[0], ...patch }]),
  ]) assert.equal(readCodexQuestionFields(input), undefined);
});

test('Codex answers preserve exact arrays, permit explicit skips, and require every own field ID', () => {
  const fields = readCodexQuestionFields(questions);
  const answer = { ' checks ': [], context: ['commas, newlines\n and 雪 stay intact'] };
  assert.deepEqual(validateQuestionAnswers(fields, answer), answer);
  for (const input of [null, [], { ...answer, context: 'text' }, { ...answer, context: [1] },
    { context: [] }, { ...answer, extra: [] }, { ...answer, ' checks ': ['not an offered choice'] },
  ]) assert.throws(() => validateQuestionAnswers(fields, input), /field|string array|offered/);
  const prototypeFields = fields.map((f, index) => ({ ...f, id: index ? 'constructor' : '__proto__' }));
  const ownAnswers = Object.fromEntries([['__proto__', []], ['constructor', ['literal']]]);
  const mapped = validateQuestionAnswers(prototypeFields, ownAnswers);
  assert.deepEqual(mapped, ownAnswers); assert.equal(Object.getPrototypeOf(mapped), Object.prototype);
  assert.throws(() => validateQuestionAnswers(prototypeFields, Object.create(ownAnswers)), /field IDs/);
});
