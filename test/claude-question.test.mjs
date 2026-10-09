import test from 'node:test';
import assert from 'node:assert/strict';
import { readClaudeQuestionFields, claudeQuestionAnswers } from '../dist/claude-question.js';

const choice = (question, extra = {}) => ({ question, header: 'Same header', options: [
  { label: 'Read, write', description: 'Only assigned files', preview: '<pre>work.txt</pre>' },
  { label: 'Review', description: 'Read only' },
], ...extra });
const form = () => ({ title: 'Task context', metadata: { source: 'fixture' }, questions: [
  choice(' Which checks? '), choice('Which outputs?', { multiSelect: true }),
  { question: 'What marker?', header: 'Context', kind: 'text', placeholder: 'Literal marker', description: 'Assigned context' },
  { question: 'How many?', header: 'Count', kind: 'number', min: 1, max: 10, step: 1, defaultValue: 2, unit: 'items' },
] });

test('Claude fields preserve full-text identity, previews and extended form hints without applying defaults', () => {
  const input = form(), snapshot = structuredClone(input), fields = readClaudeQuestionFields(input);
  assert.deepEqual(input,snapshot);
  assert.deepEqual(fields.map(f=>f.id),input.questions.map(q=>q.question));
  assert.deepEqual(fields.map(f=>f.multiSelect),[false,true,false,false]);
  assert(fields.every(f=>f.allowOther&&!f.isSecret));
  assert.deepEqual(fields[0].options,input.questions[0].options);
  assert.equal(fields[0].header,fields[1].header,'headers are not answer keys');
  assert.deepEqual(fields[2].options,[]); assert.match(fields[2].description,/Literal marker/);
  assert.match(fields[3].description,/min.*1.*max.*10.*step.*1.*defaultValue.*2.*unit.*items/);
  assert.equal(fields[3].prefill,undefined,'a native default is only a displayed suggestion');
  assert.equal(readClaudeQuestionFields({questions:[choice('Optional description?',{options:[{label:'A'},{label:'B'}]})]})[0].options[0].description,'');
  const blank=readClaudeQuestionFields({questions:[choice('',{header:' ',options:[{label:''},{label:' '}]})]});
  assert(blank,'native string fields have no non-empty schema constraint');
  assert.equal(blank[0].id,'');assert.equal(blank[0].header,' ');assert.equal(blank[0].options[0].label,'');
  assert.deepEqual(claudeQuestionAnswers(blank,{'':[' ']}),{'':' '});
});

test('Claude malformed, unknown and host-owned question shapes fail closed', () => {
  const mutations = [
    x=>delete x.questions, x=>x.questions=[], x=>x.questions.push(choice('Too many?')),
    x=>x.questions[1].question=x.questions[0].question, x=>x.title=3,
    ...['answers','annotations','response','followUp','afkTimeoutMs'].map(key=>x=>x[key]={}),
    x=>x.questions[0].question=0, x=>x.questions[0].header=null, x=>x.questions[0].kind='future',
    x=>x.questions[0].options[0].label=null,
    x=>x.questions[0].kind=null, x=>x.questions[2].options=null,
    x=>x.questions[0].multiSelect='true', x=>x.questions[0].options=[],
    x=>x.questions[0].options.push(...Array.from({length:3},(_,i)=>({label:String(i)}))),
    x=>x.questions[0].options[1].label=x.questions[0].options[0].label,
    x=>x.questions[0].options[0].preview={}, x=>x.questions[0].options[0].description=3,
    x=>x.questions[0].options[0].futureConsent=true, x=>x.questions[0].futureConsent=true,
    x=>x.questions[2].multiSelect=true, x=>x.questions[2].options=[{label:'A'},{label:'B'}],
    x=>x.questions[2].min=1, x=>x.questions[3].placeholder='not a text question',
    x=>x.questions[3].max=0, x=>x.questions[3].min=NaN, x=>x.questions[3].step=0,
    x=>x.questions[3].defaultValue=11, x=>x.questions[3].unit={},
  ];
  for(const [i,change] of mutations.entries()) {const input=form();change(input);assert.equal(readClaudeQuestionFields(input),undefined,`mutation ${i}`);}
  for(const input of [null,[],{}, {questions:[null]}]) assert.equal(readClaudeQuestionFields(input),undefined);
});

test('Claude answers use question text, keep multiselect arrays for native escaping, and explicitly skip without guessing', () => {
  const fields=readClaudeQuestionFields(form());
  const answers={' Which checks? ':['custom, exact'],'Which outputs?':['Read, write','say "hello"'],'What marker?':[' literal\nmarker '],'How many?':[]};
  const output=claudeQuestionAnswers(fields,answers);
  assert.deepEqual(output,{' Which checks? ':'custom, exact','Which outputs?':['Read, write','say "hello"'],'What marker?':' literal\nmarker ','How many?':''});
  output['Which outputs?'].push('mutated'); assert.equal(answers['Which outputs?'].length,2);
  const protoFields=readClaudeQuestionFields({questions:[choice('__proto__')]});
  const proto=claudeQuestionAnswers(protoFields,Object.fromEntries([['__proto__',['literal']]]));
  assert.equal(Object.getPrototypeOf(proto),Object.prototype); assert.equal(Object.hasOwn(proto,'__proto__'),true); assert.equal(proto.__proto__,'literal');
});

test('Claude answer validation enforces field identity, cardinality and native admission size before writing', () => {
  const fields=readClaudeQuestionFields(form()), empty=Object.fromEntries(fields.map(f=>[f.id,[]]));
  for(const answers of [null,[],{}, {...empty,extra:[]}, {...empty,'Same header':[]},
    {...empty,'What marker?':'not an array'}, {...empty,'What marker?':[3]},
    {...empty,' Which checks? ':['Read, write','Review']}, {...empty,'Which outputs?':['a','b','c','d']},
    {...empty,'What marker?':['x'.repeat(8193)]},
    {...empty,'Which outputs?':Array(2).fill('"'.repeat(8192))},
  ]) assert.throws(()=>claudeQuestionAnswers(fields,answers),/field|array|string|single|one|many|limit|large/i);
  const boundary={...empty,'What marker?':['x'.repeat(8192)]};
  assert.equal(claudeQuestionAnswers(fields,boundary)['What marker?'].length,8192);
  const textBoundary={...empty,'Which outputs?':Array(2).fill('"'.repeat(8190)),'What marker?':['xx']};
  assert.doesNotThrow(()=>claudeQuestionAnswers(fields,textBoundary),'32768 encoded characters are accepted');
  assert.throws(()=>claudeQuestionAnswers(fields,{...textBoundary,'What marker?':['xxx']}),/large|limit/i);
  const keyBoundary=fields.slice(0,2).map((field,i)=>({...field,id:String(i)+'x'.repeat(23_999)}));
  assert.doesNotThrow(()=>claudeQuestionAnswers(keyBoundary,Object.fromEntries(keyBoundary.map(f=>[f.id,[]]))),'48000 key characters with no text are accepted');
  const hugeIds=fields.slice(0,2).map((field,i)=>({...field,id:String(i)+'x'.repeat(24_000)}));
  assert.throws(()=>claudeQuestionAnswers(hugeIds,Object.fromEntries(hugeIds.map(f=>[f.id,[]]))),/large|limit/i);
});
