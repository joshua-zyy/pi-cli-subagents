// User-owned directories and Git worktrees; deterministic native CLIs, no models.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AgentManager } from '../dist/manager.js';
import { processAlive, readJson, waitUntil } from '../dist/storage.js';
import { tempDir } from './helpers/tmp.mjs';

const launch = cli => ({ command: process.execPath, args: [fileURLToPath(new URL(`./fixtures/${cli}.mjs`, import.meta.url))] });
const role = cli => ({ cli, description: 'fixture', instructions: 'Only the assigned fixture task' });
const fileTask = (file, content) => `FILE ${JSON.stringify({ file, ...(content === undefined ? {} : { content }) })}`;
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=', '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
function setup(t, cli, flags = []) {
  const root = tempDir(`cwd-${cli}`), home = path.join(root, 'home'), parent = path.join(root, 'parent.jsonl');
  fs.mkdirSync(home); fs.writeFileSync(path.join(home, 'fixture-home'), '');
  const native = { launch: { ...launch(cli), args: [...launch(cli).args, ...flags] }, home };
  const manager = new AgentManager(parent, launch('pi'), cli === 'codex' ? native : undefined, cli === 'claude' ? native : undefined);
  t.after(async () => { for (const state of manager.list()) if (processAlive(state.workerPid)) await manager.close(state.id); });
  const done = (id, status = 'completed') => waitUntil('cwd run result', () => {
    const state = manager.get(id);
    return ['idle', 'closed'].includes(state.phase) && state.lastStatus === status ? state : undefined;
  }, 15000);
  const release = async id => {
    const closed = await manager.close(id);
    assert.equal(closed.receipt.status, 'released');
    assert.equal(fs.existsSync(path.join(manager.root, id, 'owner.lock')), false);
    return closed;
  };
  return { root, home, parent, native, manager, done, release };
}

for (const cli of ['pi', 'codex', 'claude']) {
  test(`${cli}: ordinary cwd survives resident turns and original-session resume after controller reopen`, { timeout: 30000 }, async t => {
    const { root, parent, native, manager, done, release } = setup(t, cli);
    const cwd = path.join(root, 'ordinary', 'src'); fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'input.txt'), 'before\n');
    const child = await manager.spawn('worker', role(cli), cwd, 'REMEMBER original-token');
    const first = await done(child.id);
    const capabilities = { busySendModes: cli === 'codex' ? ['steer'] : ['steer', 'followUp'], interrupt: true };
    assert.deepEqual(child.capabilities, capabilities, 'start must publish capabilities before returning acceptance');
    assert.deepEqual(first.capabilities, capabilities);
    assert.deepEqual(readJson(path.join(manager.root, child.id, 'state.json')).capabilities, capabilities);
    assert.equal(first.cwd, cwd); assert.equal(first.text, 'OK');
    assert.equal(Object.hasOwn(readJson(path.join(manager.root, child.id, 'spec.json')), 'workspace'), false);
    fs.writeFileSync(path.join(cwd, 'input.txt'), 'changed between turns\n');
    await manager.send(child.id, fileTask('input.txt'));
    const second = await done(child.id);
    assert.equal(second.text, 'changed between turns\n'); assert.deepEqual(second.session, first.session);
    assert.equal(second.runtimeId, first.runtimeId); assert.notEqual(second.runId, first.runId);
    assert.deepEqual(second.capabilities, capabilities);
    const closed = await release(child.id);
    assert.deepEqual(closed.capabilities, { busySendModes: null, interrupt: null }, 'released capabilities are not live controls');
    const otherHome = { ...native, home: path.join(root, 'not-the-original-home') };
    const reopened = new AgentManager(parent, launch('pi'), cli === 'codex' ? otherHome : undefined, cli === 'claude' ? otherHome : undefined);
    await reopened.send(child.id, 'RECALL');
    const third = await done(child.id);
    assert.equal(third.text, 'original-token'); assert.deepEqual(third.session, first.session);
    assert.notEqual(third.runtimeId, first.runtimeId); assert.equal(third.runCount, 3); assert.equal(third.cwd, cwd);
    assert.deepEqual(third.capabilities, capabilities, 'a new runtime confirms its own capabilities');
    assert.deepEqual(third.history.map(run => run.status), ['completed', 'completed', 'completed']);
    assert.equal(manager.getResult(child.id, first.runId).text, 'OK');
    assert.equal(fs.existsSync(path.join(manager.root, 'workspaces')), false);
    await release(child.id);
  });

  test(`${cli}: parallel children use their own cwd without crossing file writes`, { timeout: 20000 }, async t => {
    const { root, manager, done, release } = setup(t, cli);
    const dirs = ['a', 'b'].map(name => path.join(root, name));
    for (const dir of dirs) fs.mkdirSync(dir);
    const children = await Promise.all(dirs.map((cwd, i) => manager.spawn('worker', role(cli), cwd, fileTask('result.txt', `child-${i}\n`))));
    const results = await Promise.all(children.map(child => done(child.id)));
    assert.notEqual(results[0].sessionId, results[1].sessionId);
    for (const [i, result] of results.entries()) {
      assert.equal(result.cwd, dirs[i]); assert.equal(result.text, `child-${i}\n`);
      assert.equal(fs.readFileSync(path.join(dirs[i], 'result.txt'), 'utf8'), `child-${i}\n`);
      await release(result.id);
    }
  });

  test(`${cli}: a user-created branch worktree is just cwd, including commits between turns`, { timeout: 30000 }, async t => {
    const { root, manager, done, release } = setup(t, cli);
    const repo = path.join(root, 'repo'), tree = path.join(root, 'user-tree');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@invalid');
    git(repo, 'config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(repo, 'src/base.txt'), 'committed\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'baseline');
    fs.writeFileSync(path.join(repo, 'parent-only.txt'), 'do not inherit or modify\n');
    const parentHead = git(repo, 'rev-parse', 'HEAD'), parentIndex = fs.readFileSync(path.join(repo, '.git/index'));
    git(repo, 'worktree', 'add', '-b', `user-${cli}`, tree, 'HEAD');
    const cwd = path.join(tree, 'src');
    const child = await manager.spawn('worker', role(cli), cwd, fileTask('base.txt', `${cli}\n`));
    const first = await done(child.id);
    assert.equal(fs.readFileSync(path.join(repo, 'src/base.txt'), 'utf8'), 'committed\n');
    assert.equal(fs.existsSync(path.join(tree, 'parent-only.txt')), false);
    await release(child.id);
    git(tree, 'add', 'src/base.txt'); git(tree, 'commit', '-qm', 'user-selected commit');
    const committed = git(tree, 'rev-parse', 'HEAD');
    await manager.send(child.id, fileTask('base.txt'));
    const second = await done(child.id);
    assert.equal(second.text, `${cli}\n`); assert.equal(second.cwd, cwd); assert.deepEqual(second.session, first.session);
    assert.equal(git(tree, 'rev-parse', 'HEAD'), committed); assert.equal(git(tree, 'branch', '--show-current').trim(), `user-${cli}`);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), parentHead); assert.deepEqual(fs.readFileSync(path.join(repo, '.git/index')), parentIndex);
    assert.equal(fs.readFileSync(path.join(repo, 'parent-only.txt'), 'utf8'), 'do not inherit or modify\n');
    assert.equal(fs.existsSync(path.join(manager.root, 'workspaces')), false);
    await release(child.id);
    git(repo, 'worktree', 'remove', tree);
  });
}

for (const cli of ['codex', 'claude']) test(`${cli}: failed cwd resume retains the original native identity and files`, { timeout: 20000 }, async t => {
  const { root, manager, done, release } = setup(t, cli, ['--reject-resume']);
  const child = await manager.spawn('worker', role(cli), root, 'REMEMBER original-token');
  const first = await done(child.id); await release(child.id);
  fs.writeFileSync(path.join(root, 'retained.txt'), 'external change\n');
  await manager.send(child.id, 'RECALL');
  const failed = await done(child.id, 'failed');
  assert.match(failed.error, /resume rejected/i); assert.equal(failed.accepted, false);
  assert.deepEqual(failed.session, first.session); assert.equal(failed.runCount, 2);
  assert.equal(fs.readFileSync(path.join(root, 'retained.txt'), 'utf8'), 'external change\n');
  assert.equal(manager.getResult(child.id, first.runId).text, 'OK');
});
