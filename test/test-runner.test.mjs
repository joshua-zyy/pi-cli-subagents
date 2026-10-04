// Exercise the actual launcher in an isolated miniature repository; never load a CLI/model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture(t, fail = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts')); fs.mkdirSync(path.join(root, 'test'));
  fs.copyFileSync(new URL('../scripts/test.mjs', import.meta.url), path.join(root, 'scripts/test.mjs'));
  const home = path.join(root, 'user-home'); fs.mkdirSync(home);
  const config = JSON.stringify({worker:{cli:'claude',description:'must not load',instructions:'must not run'}});
  fs.writeFileSync(path.join(home, 'cli-subagents.roles.json'), config);
  fs.writeFileSync(path.join(root, 'test/probe.test.mjs'), `
    import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path';
    const home = process.env.PI_CODING_AGENT_DIR;
    fs.writeFileSync('receipt.json', JSON.stringify({home}));
    assert.equal(process.env.PI_CLI_SUBAGENT, undefined, 'child marker must be cleared before module import');
    assert.notEqual(home, ${JSON.stringify(home)}, 'user home must be isolated before module import');
    assert.deepEqual(fs.readdirSync(home), [], 'fresh home must not contain user roles');
    test('local probe', () => { assert.equal(${fail}, false, 'intentional fixture failure'); });
  `);
  fs.writeFileSync(path.join(root, 'test/real-smoke.mjs'), "throw new Error('real-model entry must never be selected');");
  const run = () => {
    const env = {...process.env, PI_CLI_SUBAGENT:'1', PI_CODING_AGENT_DIR:home};
    // This is a new runner process, not a node:test child belonging to the outer suite.
    delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, [path.join(root, 'scripts/test.mjs')], {
      cwd: os.tmpdir(), env, encoding:'utf8', timeout:15000,
    });
  };
  return {root, home, config, run};
}

test('launcher isolates user configuration and child markers before import, then removes its temporary home', t => {
  const h = fixture(t), result = h.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const receipt = JSON.parse(fs.readFileSync(path.join(h.root, 'receipt.json')));
  assert.equal(fs.existsSync(receipt.home), false, 'temporary test home is removed after success');
  assert.equal(fs.readFileSync(path.join(h.home, 'cli-subagents.roles.json'), 'utf8'), h.config);
  assert.match(result.stdout, /# tests 1/);
});

test('launcher preserves failing exit status and removes the temporary home without changing user configuration', t => {
  const h = fixture(t, true), result = h.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /intentional fixture failure/);
  const receipt = JSON.parse(fs.readFileSync(path.join(h.root, 'receipt.json')));
  assert.equal(fs.existsSync(receipt.home), false);
  assert.equal(fs.readFileSync(path.join(h.home, 'cli-subagents.roles.json'), 'utf8'), h.config);
});
