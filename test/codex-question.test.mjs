import test from 'node:test';
import assert from 'node:assert/strict';
import { readCodexQuestionFields, validateQuestionAnswers } from '../dist/codex-question.js';

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
