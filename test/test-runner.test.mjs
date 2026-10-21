// Exercise the actual launcher in an isolated miniature repository; never load a CLI/model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function fixture(t, fail = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts')); fs.mkdirSync(path.join(root, 'test'));
  fs.copyFileSync(new URL('../scripts/test.mjs', import.meta.url), path.join(root, 'scripts/test.mjs'));
  const tiers = {fast:['probe.test.mjs'], domain:['domain.test.mjs'], 'acceptance-local':['acceptance.test.mjs'], 'acceptance-slow':[]};
  const saveTiers = () => fs.writeFileSync(path.join(root, 'scripts/test-tiers.json'), JSON.stringify(tiers));
  saveTiers();
  for (const file of ['domain.test.mjs','acceptance.test.mjs']) fs.writeFileSync(path.join(root, 'test', file), `import test from 'node:test'; import fs from 'node:fs'; test('${file}', () => fs.appendFileSync('selected.txt', '${file}\\n'));`);
  const home = path.join(root, 'user-home'); fs.mkdirSync(home);
  const config = JSON.stringify({worker:{cli:'claude',description:'must not load',instructions:'must not run'}});
  fs.writeFileSync(path.join(home, 'cli-subagents.roles.json'), config);
  fs.writeFileSync(path.join(root, 'test/probe.test.mjs'), `
    import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs';
    const home = process.env.PI_CODING_AGENT_DIR;
    fs.writeFileSync('receipt.json', JSON.stringify({home}));
    assert.equal(process.env.PI_CLI_SUBAGENT, undefined, 'child marker must be cleared before module import');
    assert.notEqual(home, ${JSON.stringify(home)}, 'user home must be isolated before module import');
    assert.deepEqual(fs.readdirSync(home), [], 'fresh home must not contain user roles');
    test('local probe', () => { assert.equal(${fail}, false, 'intentional fixture failure'); });
  `);
  fs.writeFileSync(path.join(root, 'test/real-smoke.mjs'), "throw new Error('real-model entry must never be selected');");
  const run = (args = []) => {
    const env = {...process.env, PI_CLI_SUBAGENT:'1', PI_CODING_AGENT_DIR:home};
    // This is a new runner process, not a node:test child belonging to the outer suite.
    delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, [path.join(root, 'scripts/test.mjs'), ...args], {
      cwd: os.tmpdir(), env, encoding:'utf8', timeout:15000,
    });
  };
  return {root, home, config, run, tiers, saveTiers};
}

test('launcher isolates user configuration and child markers before import, then removes its temporary home', t => {
  const h = fixture(t), result = h.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const receipt = JSON.parse(fs.readFileSync(path.join(h.root, 'receipt.json')));
  assert.equal(fs.existsSync(receipt.home), false, 'temporary test home is removed after success');
  assert.equal(fs.readFileSync(path.join(h.home, 'cli-subagents.roles.json'), 'utf8'), h.config);
  assert.match(result.stdout, /# tests 3/);
});

test('tier listings are disjoint and complete without executing fixtures; selected tiers run independently', t => {
  const h = fixture(t), names = [];
  for (const tier of ['fast','domain','acceptance-local','acceptance-slow']) {
    const result = h.run([tier, '--list']);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout); assert.equal(plan.tier, tier);
    assert.deepEqual(plan.files, h.tiers[tier]); names.push(...plan.files);
  }
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(JSON.parse(h.run(['all','--list']).stdout).files, names.sort());
  assert.equal(fs.existsSync(path.join(h.root, 'receipt.json')), false);
  assert.equal(fs.existsSync(path.join(h.root, 'selected.txt')), false);
  const fast = h.run(['fast']); assert.equal(fast.status, 0, fast.stdout + fast.stderr);
  assert.match(fast.stdout, /# tests 1/); assert.match(fast.stdout, /NOT_RUN/);
  assert.equal(fs.existsSync(path.join(h.root, 'selected.txt')), false);
  const domain = h.run(['domain','domain.test.mjs']); assert.equal(domain.status, 0, domain.stdout + domain.stderr);
  assert.match(domain.stdout, /# tests 1/);
  assert.equal(fs.readFileSync(path.join(h.root, 'selected.txt'), 'utf8'), 'domain.test.mjs\n');
  const acceptance = h.run(['acceptance-local']); assert.equal(acceptance.status, 0, acceptance.stdout + acceptance.stderr);
  assert.match(acceptance.stdout, /# tests 1/);
});

test('invalid tiers, cross-tier files and real-model entry requests fail before fixture execution', t => {
  const h = fixture(t);
  for (const args of [['real'],['fast','domain.test.mjs'],['all','real-smoke.mjs'],['all','../real-smoke.mjs']]) {
    const result = h.run(args); assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Unknown tier|not selected/);
    assert.equal(fs.existsSync(path.join(h.root, 'receipt.json')), false);
    assert.equal(fs.existsSync(path.join(h.root, 'selected.txt')), false);
  }
});

test('unclassified, duplicated, missing or non-test manifest entries fail closed before import', t => {
  const h = fixture(t), original = structuredClone(h.tiers);
  for (const [patch, error] of [
    [() => h.tiers.fast = [], /Unclassified/],
    [() => h.tiers.domain.push('probe.test.mjs'), /Duplicate/],
    [() => h.tiers.fast.push('missing.test.mjs'), /Missing/],
    [() => h.tiers.fast.push('real-smoke.mjs'), /Invalid/],
  ]) {
    Object.assign(h.tiers, structuredClone(original)); patch(); h.saveTiers();
    const result = h.run(); assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, error);
    assert.equal(fs.existsSync(path.join(h.root, 'receipt.json')), false);
    assert.equal(fs.existsSync(path.join(h.root, 'selected.txt')), false);
  }
});

test('launcher preserves failing exit status and removes the temporary home without changing user configuration', t => {
  const h = fixture(t, true), result = h.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /intentional fixture failure/);
  const receipt = JSON.parse(fs.readFileSync(path.join(h.root, 'receipt.json')));
  assert.equal(fs.existsSync(receipt.home), false);
  assert.equal(fs.readFileSync(path.join(h.home, 'cli-subagents.roles.json'), 'utf8'), h.config);
});

function gateFixture(t, failures = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'node-gates-fixture-'));
  const directory = path.join(temporary, 'space 中文 & argv');
  fs.mkdirSync(directory);
  const root = fs.realpathSync(directory);
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const name of ['gates.mjs', 'build.mjs']) {
    const source = new URL(`../scripts/${name}`, import.meta.url);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(root, 'scripts', name));
  }
  fs.mkdirSync(path.join(root, 'node_modules/typescript/bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist/stale.js'), 'must be removed before compile');
  fs.writeFileSync(path.join(root, 'node_modules/typescript/bin/tsc'), `
    const fs = require('node:fs');
    const check = process.argv.includes('--noEmit');
    fs.appendFileSync('executed.jsonl', JSON.stringify({label:check ? 'check' : 'compile', cwd:process.cwd(), args:process.argv.slice(2)}) + '\\n');
    if (!check) {
      if (fs.existsSync('dist/stale.js')) throw new Error('stale build output survived');
      fs.mkdirSync('dist', {recursive:true}); fs.writeFileSync('dist/fresh.js', 'compiled');
    }
    process.exit(check ? ${failures.check ?? 0} : ${failures.build ?? 0});
  `);
  fs.writeFileSync(path.join(root, 'scripts/test.mjs'), `
    import fs from 'node:fs';
    const tier = process.argv[2];
    fs.appendFileSync('executed.jsonl', JSON.stringify({label:tier, cwd:process.cwd()}) + '\\n');
    process.exit(tier === 'fast' ? ${failures.fast ?? 0} : 0);
  `);
  const guard = path.join(root, 'guard.mjs');
  fs.writeFileSync(guard, `
    import cp from 'node:child_process'; import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const spawn = cp.spawnSync;
    cp.spawnSync = (command, args, options) => {
      if (command !== process.execPath || options.shell !== false) throw new Error('gate must launch Node without a shell');
      fs.appendFileSync(${JSON.stringify(path.join(root, 'launches.jsonl'))}, JSON.stringify({command,args,cwd:options.cwd,shell:options.shell}) + '\\n');
      return spawn(command, args, options);
    };
    syncBuiltinESMExports();
  `);
  const run = (script = 'gates.mjs', args = []) => {
    const env = { ...process.env, NODE_OPTIONS: `--import ${JSON.stringify(pathToFileURL(guard).href)}` };
    delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], {
      cwd: os.tmpdir(), env, encoding: 'utf8', timeout: 15000,
    });
  };
  const records = name => fs.readFileSync(path.join(root, name), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { root, run, records };
}

test('gates launch only Node argv without a shell, build once and select the requested tiers from any cwd', t => {
  for (const slow of [false, true]) {
    const h = gateFixture(t), result = h.run('gates.mjs', slow ? ['--slow'] : []);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const tiers = ['fast', 'domain', 'acceptance-local', ...(slow ? ['acceptance-slow'] : [])];
    const executed = h.records('executed.jsonl');
    assert.deepEqual(executed.map(record => record.label), ['check', 'compile', ...tiers]);
    assert.ok(executed.every(record => record.cwd === h.root));
    assert.deepEqual(executed[0].args, ['-p', 'tsconfig.json', '--noEmit']);
    assert.deepEqual(executed[1].args, ['-p', 'tsconfig.json']);
    const launches = h.records('launches.jsonl');
    assert.equal(launches.length, 3 + tiers.length, 'check, shared build entry, compiler, then each tier');
    assert.ok(launches.every(record => record.command === process.execPath && record.shell === false && path.resolve(record.cwd) === h.root));
    assert.equal(fs.existsSync(path.join(h.root, 'dist/stale.js')), false);
    assert.equal(fs.readFileSync(path.join(h.root, 'dist/fresh.js'), 'utf8'), 'compiled');
    assert.match(result.stdout, /all gates passed/);
    assert.match(result.stdout, /real CLI\/model acceptance is NOT_RUN/);
  }
});

test('gates keep check and tier failures nonzero while still running the remaining selected gates', t => {
  const h = gateFixture(t, { check: 3, fast: 4 }), result = h.run('gates.mjs', ['--slow']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(h.records('executed.jsonl').map(record => record.label), ['check', 'compile', 'fast', 'domain', 'acceptance-local', 'acceptance-slow']);
  assert.match(result.stdout, /2 gate\(s\) failed: check, fast/);
});

test('gates do not run test tiers after a failed build', t => {
  const h = gateFixture(t, { build: 7 }), result = h.run('gates.mjs', ['--slow']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(h.records('executed.jsonl').map(record => record.label), ['check', 'compile']);
  assert.match(result.stdout, /1 gate\(s\) failed: build/);
});

test('the shared build entry cleans stale output and preserves the compiler failure exit code', t => {
  assert.equal(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).scripts.build, 'node scripts/build.mjs');
  const h = gateFixture(t, { build: 7 }), result = h.run('build.mjs');
  assert.equal(result.status, 7, result.stdout + result.stderr);
  assert.deepEqual(h.records('executed.jsonl').map(record => record.label), ['compile']);
  assert.equal(fs.existsSync(path.join(h.root, 'dist/stale.js')), false);
});
