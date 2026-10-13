// Local CLI discovery: what is installed, and which models each CLI publishes about itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EMPTY_CATALOG, detectClis, modelEfforts, parseCodexModels, parsePiModels, probeCatalog } from '../dist/cli-discovery.js';
import { tempDir } from './helpers/tmp.mjs';

test('the Pi table and the Codex catalog are read from the CLIs’ own output', () => {
  const table = ['provider          model                         context  max-out  thinking  images',
    'opencode-go       deepseek-v4.1-flash           1M       131.1K   yes       yes   ',
    'anthropic         claude-opus-5                 400K     64K      yes       yes   ',
    'opencode-go       space-bunny-free              1.0M     524.3K   yes       yes   ', ''].join('\n');
  assert.deepEqual(parsePiModels(table), [
    { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    { provider: 'anthropic', model: 'claude-opus-5' },
    { provider: 'opencode-go', model: 'space-bunny-free' },
  ]);
  assert.deepEqual(parsePiModels('provider  model'), [], 'a header alone publishes nothing');
  assert.deepEqual(parsePiModels(''), []);

  const catalog = JSON.stringify({ models: [
    { slug: 'gpt-6-luna', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }] },
    { slug: 'gpt-6-astra', supported_reasoning_levels: [] },
    { slug: '' },
  ] });
  assert.deepEqual(parseCodexModels(catalog), [{ model: 'gpt-6-luna', efforts: ['low', 'max'] }, { model: 'gpt-6-astra' }]);
  assert.throws(() => parseCodexModels('not json'), SyntaxError);
  assert.throws(() => parseCodexModels('{"models":{}}'), /model list/, 'an unexpected shape is not a catalog');
});

test('a model publishes its own effort levels, and an unknown model publishes none', () => {
  const catalog = { pi: [], codex: [{ model: 'gpt-6-luna', efforts: ['low', 'high', 'max', 'ultra'] }] };
  assert.deepEqual(modelEfforts(catalog, 'gpt-6-luna'), ['low', 'high', 'max', 'ultra']);
  assert.equal(modelEfforts(catalog, 'gpt-6-astra'), undefined);
  assert.equal(modelEfforts(EMPTY_CATALOG, undefined), undefined);
});

test('a cached available CLI whose launcher now fails contributes an empty catalog, not a rejected probe', async t => {
  const platform = Object.getOwnPropertyDescriptor(process,'platform'), savedPath = process.env.PATH, calls = [];
  Object.defineProperty(process,'platform',{value:'win32'});
  process.env.PATH = tempDir('stale-launcher');
  const missing = t.mock.method(fs,'existsSync',()=>{throw new Error('cached launcher is no longer readable');});
  const exec = t.mock.method(childProcess,'execFile',(_command,args,_options,callback)=>{
    calls.push(args); callback(null,'provider  model\nfixture  known\n'); return {stdin:{end(){}}};
  });
  syncBuiltinESMExports();
  try {
    const catalog = await probeCatalog({pi:{command:process.execPath,args:[]},cwd:process.cwd(),available:{pi:true,codex:true,claude:false}});
    assert.deepEqual(catalog,{pi:[{provider:'fixture',model:'known'}],codex:[]});
    assert.deepEqual(calls,[['--list-models']],'never launch a broken CLI or retry with a shell');
    const checked = missing.mock.callCount();
    assert.deepEqual(await probeCatalog({pi:{command:process.execPath,args:[]},cwd:process.cwd(),available:{pi:false,codex:false,claude:false}}),EMPTY_CATALOG);
    assert.equal(missing.mock.callCount(),checked,'unavailable CLIs are not resolved');
  } finally {
    Object.defineProperty(process,'platform',platform);
    if(savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    missing.mock.restore(); exec.mock.restore(); syncBuiltinESMExports();
  }
});

test('availability follows PATH instead of a hardcoded list', () => {
  const before = detectClis();
  assert.equal(before.pi, true, 'Pi is the host process, so it is always available');
  const saved = process.env.PATH;
  try {
    process.env.PATH = tempDir('empty-path');
    assert.deepEqual(detectClis(), { pi: true, codex: false, claude: false }, 'an empty PATH installs nothing');
  } finally { process.env.PATH = saved; }
  assert.deepEqual(detectClis(), before, 'restoring PATH restores the answer');
});
