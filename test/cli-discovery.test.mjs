// Local CLI discovery: what is installed, and which models each CLI publishes about itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { codexDefaultValues, readCodexDefaults, readClaudeDefaults, claudeDefaultValues } from '../dist/role-defaults.js';
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

test('Codex defaults keep both approval/sandbox axes, false gates and unspecified defaults', () => {
  const raw={model:'native-model',model_reasoning_effort:'xhigh',sandbox_mode:'workspace-write',approval_policy:'on-request',features:{default_mode_request_user_input:false}};
  assert.deepEqual(codexDefaultValues(raw),{model:'native-model',effort:'xhigh',mode:'workspace-write',defaultModeQuestions:'false'});
  assert.equal(codexDefaultValues({...raw,approval_policy:'untrusted'}).mode,'workspace-write / untrusted','never mislabel a native combination as our on-request preset');
  assert.equal(codexDefaultValues({...raw,approval_policy:'never'}).mode,'workspace-write / never');
  assert.deepEqual(codexDefaultValues({}),{model:'default',effort:'default',mode:'default',defaultModeQuestions:'default'});
});

test('the Codex defaults probe reads only config after initialize and closes without starting a thread', async t => {
  const messages=[], child=new EventEmitter(); child.stdout=new PassThrough(); child.stdin=new EventEmitter();
  child.stdin.write=s=>{const m=JSON.parse(s);messages.push(m);setImmediate(()=>{
    if(m.id===1)child.stdout.write('{"id":1,"result":{}}\n');
    if(m.id===2){child.stdout.write('{"id":2,"result":{"config":{"model":"fixture-model",');child.stdout.write('"model_reasoning_effort":"high"}}}\n');}
  });};
  child.stdin.end=()=>setImmediate(()=>child.emit('close',0));
  const spawn=t.mock.method(childProcess,'spawn',(_command,args,options)=>{assert.equal(args.at(-1),'app-server');assert.equal(options.shell,false);return child;});
  syncBuiltinESMExports();
  try {
    const result=await readCodexDefaults(process.cwd(),1000);
    assert.equal(result.model,'fixture-model');assert.equal(result.effort,'high');
    assert.deepEqual(messages.map(m=>m.method),['initialize','initialized','config/read']);
    assert.deepEqual(messages[2].params,{cwd:process.cwd(),includeLayers:false});
  } finally {spawn.mock.restore();syncBuiltinESMExports();}
});

test('default probe launcher failure, malformed responses and deadlines remain unconfirmed, never guessed', async t => {
  const bad=t.mock.method(childProcess,'spawn',()=>{throw new Error('launcher failed');});syncBuiltinESMExports();
  assert.equal(await readCodexDefaults(process.cwd(),20),undefined); bad.mock.restore();syncBuiltinESMExports();
  for(const malformed of [true,false]) {
    const child=new EventEmitter();child.stdout=new PassThrough();child.stdin=new EventEmitter();child.stdin.write=()=>{if(malformed)setImmediate(()=>child.stdout.write('not json\n'));};
    // No OS pid: the tree cleanup helper must not target any real process.
    const spawn=t.mock.method(childProcess,'spawn',()=>child);syncBuiltinESMExports();
    try {assert.equal(await readCodexDefaults(process.cwd(),20),undefined);}
    finally {spawn.mock.restore();syncBuiltinESMExports();}
  }
});

function claudeFixture(t) {
  const root=tempDir('native-defaults'), home=path.join(root,'claude'), cwd=path.join(root,'project');
  fs.mkdirSync(home);fs.mkdirSync(path.join(cwd,'.claude'),{recursive:true});fs.mkdirSync(path.join(cwd,'.git'));
  const read=fs.readFileSync;
  // Never consume machine-managed or personal settings on any platform in this fixture.
  const mock=t.mock.method(fs,'readFileSync',(file,...args)=>{
    if(!path.resolve(String(file)).startsWith(root+path.sep))throw Object.assign(new Error('fixture missing'),{code:'ENOENT'});
    return read(file,...args);
  });syncBuiltinESMExports();
  t.after(()=>{mock.mock.restore();syncBuiltinESMExports();fs.rmSync(root,{recursive:true,force:true});});
  const env={CLAUDE_CONFIG_DIR:home,ProgramFiles:path.join(root,'system')};
  return {home,cwd,env,write:(file,data)=>fs.writeFileSync(file,JSON.stringify(data))};
}

test('Claude local defaults merge allowed environment values, scopes, model effort and caps without retaining credentials', t => {
  const f=claudeFixture(t);
  f.env.ANTHROPIC_MODEL='shell-model';f.env.CLAUDE_CODE_EFFORT_LEVEL='max';
  f.write(path.join(f.home,'settings.json'),{model:'user-model',permissions:{defaultMode:'bypassPermissions'},effortLevel:'high',
    modelSettings:{'canonical-model':{effortLevel:'high'}},env:{ANTHROPIC_MODEL:'canonical-model',ANTHROPIC_API_KEY:'never-retain-credential'}});
  f.write(path.join(f.cwd,'.claude','settings.json'),{effortLevel:'low',maxEffortLevel:'medium',env:{CLAUDE_CODE_EFFORT_LEVEL:'high'}});
  let snapshot=readClaudeDefaults(f.cwd,f.env), actual=claudeDefaultValues(snapshot,{cli:'claude'});
  assert.deepEqual(actual,{model:'canonical-model',thinking:'medium',mode:'bypassPermissions'});
  assert.doesNotMatch(JSON.stringify(snapshot),/never-retain-credential|ANTHROPIC_API_KEY/);
  f.write(path.join(f.cwd,'.claude','settings.local.json'),{modelSettings:{'canonical-model':{effortLevel:'low'}},permissions:{defaultMode:'default'},env:{CLAUDE_CODE_EFFORT_LEVEL:'low'}});
  actual=claudeDefaultValues(readClaudeDefaults(f.cwd,f.env),{cli:'claude'});
  assert.deepEqual(actual,{model:'canonical-model',thinking:'low',mode:'manual'});
});

test('Claude alias effort is model-specific and project permissive modes do not masquerade as active defaults', t => {
  const f=claudeFixture(t);
  f.write(path.join(f.home,'settings.json'),{model:'sonnet',permissions:{defaultMode:'bypassPermissions'},
    env:{ANTHROPIC_DEFAULT_SONNET_MODEL:'canonical-sonnet'},modelSettings:{'canonical-sonnet':{effortLevel:'high'},other:{effortLevel:'medium'}}});
  let s=readClaudeDefaults(f.cwd,f.env);
  assert.equal(claudeDefaultValues(s,{cli:'claude'}).thinking,'high');
  assert.equal(claudeDefaultValues(s,{cli:'claude',model:'other'}).thinking,'medium');
  assert.equal(claudeDefaultValues(s,{cli:'claude',model:'constructor'}).thinking,'default');
  for(const [mode,expected]of [['auto','default'],['bypassPermissions','manual']]) {
    f.write(path.join(f.cwd,'.claude','settings.json'),{permissions:{defaultMode:mode}});
    s=readClaudeDefaults(f.cwd,f.env);assert.equal(claudeDefaultValues(s,{cli:'claude'}).mode,expected);
  }
  f.write(path.join(f.cwd,'.claude','settings.json'),{effortLevel:'low'});
  assert.equal(claudeDefaultValues(readClaudeDefaults(f.cwd,f.env),{cli:'claude'}).thinking,'low','a project global effort outranks a user per-model effort');
});

test('missing Claude configuration shows symbolic defaults; corrupt files and helpers never yield invented values', t => {
  const f=claudeFixture(t);
  assert.deepEqual(claudeDefaultValues(readClaudeDefaults(f.cwd,f.env),{cli:'claude'}),{model:'default',thinking:'default',mode:'default'});
  f.write(path.join(f.home,'settings.json'),{policyHelper:'do-not-execute',model:'wrong'});
  assert.equal(readClaudeDefaults(f.cwd,f.env),undefined);
  fs.writeFileSync(path.join(f.home,'settings.json'),'{broken');assert.equal(readClaudeDefaults(f.cwd,f.env),undefined);
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
