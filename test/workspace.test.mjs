import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WorkspaceStore } from '../dist/workspace.js';

const output = path.resolve('.test-output');
fs.mkdirSync(output, { recursive: true });
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
const put = (root, name, text) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text); };
function setup() {
  const root = fs.mkdtempSync(path.join(output, 'workspace-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Workspace Test'); git(repo, 'config', 'user.email', 'workspace@example.invalid');
  git(repo, 'config', 'core.autocrlf', 'false');
  put(repo, '.gitignore', 'ignored/\n');
  put(repo, 'src/a.txt', Array.from({ length: 20 }, (_, i) => `line ${i + 1}\n`).join(''));
  put(repo, 'src/b.txt', 'original B\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'fixture');
  const parent = path.join(root, 'parent.jsonl'); put(root, 'parent.jsonl', '{}\n');
  return { root, repo, parent, store: new WorkspaceStore(parent) };
}
function controlState(repo) {
  return {
    head: git(repo, 'rev-parse', 'HEAD'), refs: git(repo, 'show-ref'),
    index: fs.readFileSync(path.join(repo, '.git/index')).toString('base64'),
  };
}
function files(root) {
  const result = {};
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else result[path.relative(root, file)] = fs.readFileSync(file).toString('base64');
    }
  }
  walk(root); return result;
}

test('create from HEAD, report but never inherit dirty state, preserve nested cwd and Git controls', async () => {
  const { repo, parent, store } = setup();
  put(repo, 'src/b.txt', 'user staged B\n'); git(repo, 'add', 'src/b.txt');
  put(repo, 'untracked.txt', 'user untracked\n'); put(repo, 'ignored/cache', 'cache');
  const before = controlState(repo);
  const ws = await store.create(path.join(repo, 'src'));
  assert.equal(path.dirname(ws.path), `${repo}.worktrees`);
  assert.equal(path.basename(ws.path), ws.id.slice(0, 8));
  assert.equal(ws.cwd, path.join(ws.path, 'src'));
  assert.equal(ws.baseCommit, before.head.trim());
  assert.deepEqual(ws.parentChanges.sort(), ['src/b.txt', 'untracked.txt']);
  assert.equal(fs.readFileSync(path.join(ws.cwd, 'b.txt'), 'utf8'), 'original B\n');
  assert.equal(fs.existsSync(path.join(ws.path, 'untracked.txt')), false);
  assert.equal(git(ws.path, 'status', '--porcelain'), '');
  assert.equal(git(ws.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'HEAD');
  assert.deepEqual(controlState(repo), before);
  assert.equal(new WorkspaceStore(parent).get(ws.id).path, ws.path, 'workspace belongs to the persistent parent');
  assert.throws(() => new WorkspaceStore(`${parent}.other`).get(ws.id), /belong|missing/);
  assert.throws(() => store.get('../escape'), /Invalid workspace/);
});

test('non-repositories and uncommitted-only subdirectories fail before creating a worktree', async () => {
  const { root, repo, store } = setup();
  await assert.rejects(store.create(root), /git|repository/i);
  fs.mkdirSync(path.join(repo, 'not-committed'));
  await assert.rejects(store.create(path.join(repo, 'not-committed')), /commit|baseline|directory/i);
  assert.equal(fs.existsSync(`${repo}.worktrees`), false);
});

test('explicit dirty inheritance uses an internal commit without changing parent Git controls', async () => {
  const { repo, parent, store } = setup();
  put(repo, 'src/b.txt', 'staged version\n'); git(repo, 'add', 'src/b.txt');
  put(repo, 'src/b.txt', 'authorized working version\n');
  fs.unlinkSync(path.join(repo, 'src/a.txt'));
  put(repo, 'new.bin', Buffer.from([0, 255, 1])); put(repo, 'ignored/cache', 'local only');
  const before = controlState(repo), originalFiles = files(repo);
  const ws = await store.create(repo, { includeUncommitted: { reason: 'User approved these task changes as the next task baseline.' } });
  assert.notEqual(ws.baseCommit, before.head.trim());
  assert.equal(ws.parentCommit, before.head.trim());
  assert.match(ws.snapshotReason, /User approved/);
  assert.equal(git(ws.path, 'rev-parse', `${ws.baseCommit}^`).trim(), before.head.trim());
  assert.equal(git(ws.path, 'status', '--porcelain'), '');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), before.head);
  assert.equal(fs.readFileSync(path.join(ws.path, 'src/b.txt'), 'utf8'), 'authorized working version\n');
  assert.equal(fs.existsSync(path.join(ws.path, 'src/a.txt')), false);
  assert.deepEqual(fs.readFileSync(path.join(ws.path, 'new.bin')), Buffer.from([0, 255, 1]));
  assert.equal(fs.existsSync(path.join(ws.path, 'ignored/cache')), false);
  assert.deepEqual(controlState(repo), before); assert.deepEqual(files(repo), originalFiles);
  assert.equal(new WorkspaceStore(parent).get(ws.id).baseCommit, ws.baseCommit);
  put(ws.path, 'src/b.txt', 'child follow-up\n');
  const result = await store.integrate(ws.id);
  assert.deepEqual(result.changedFiles, ['src/b.txt'], 'inherited content is baseline, not the child change');
  assert.equal(fs.readFileSync(path.join(repo, 'src/b.txt'), 'utf8'), 'child follow-up\n');
  assert.deepEqual(controlState(repo), before);
});

test('dirty inheritance requires a nonempty authorization reason', async () => {
  const { repo, store } = setup(); put(repo, 'new.txt', 'private change');
  for (const includeUncommitted of [{}, { reason: '' }, { reason: '   ' }]) {
    await assert.rejects(store.create(repo, { includeUncommitted }), /reason|authoriz/i);
  }
  assert.equal(fs.existsSync(`${repo}.worktrees`), false);
});

test('an explicitly inherited snapshot can supply a new parent subdirectory', async () => {
  const { repo, store } = setup(); put(repo, 'new-dir/file.txt', 'new task directory');
  const ws = await store.create(path.join(repo, 'new-dir'), { includeUncommitted: { reason: 'User approved this new directory.' } });
  assert.equal(ws.cwd, path.join(ws.path, 'new-dir'));
  assert.equal(fs.readFileSync(path.join(ws.cwd, 'file.txt'), 'utf8'), 'new task directory');
  assert.equal(git(ws.path, 'status', '--porcelain'), '');
});

test('internal snapshots do not require user identity configuration or invoke commit signing', async () => {
  const { repo, store } = setup();
  git(repo, 'config', '--unset', 'user.name'); git(repo, 'config', '--unset', 'user.email');
  git(repo, 'config', 'user.useConfigOnly', 'true'); git(repo, 'config', 'commit.gpgSign', 'true');
  git(repo, 'config', 'gpg.program', 'nonexistent-workspace-test-signer');
  put(repo, 'new.txt', 'snapshot content');
  const before = controlState(repo);
  const ws = await store.create(repo, { includeUncommitted: { reason: 'Explicitly authorized.' } });
  assert.equal(git(ws.path, 'log', '-1', '--format=%an').trim(), 'Pi workspace snapshot');
  assert.deepEqual(controlState(repo), before);
});

test('snapshot refuses an unmerged index rather than hiding conflicts in a new baseline', async () => {
  const { repo, store } = setup();
  const blob = git(repo, 'rev-parse', 'HEAD:src/b.txt').trim();
  const input = `0 ${'0'.repeat(40)}\tsrc/b.txt\n100644 ${blob} 1\tsrc/b.txt\n100644 ${blob} 2\tsrc/b.txt\n100644 ${blob} 3\tsrc/b.txt\n`;
  execFileSync('git', ['-C', repo, 'update-index', '--index-info'], { input, windowsHide: true });
  assert.ok(git(repo, 'ls-files', '--unmerged').length);
  const before = controlState(repo);
  await assert.rejects(store.create(repo, { includeUncommitted: { reason: 'Do not silently resolve an unmerged index.' } }), /unmerged|conflict/i);
  assert.deepEqual(controlState(repo), before);
});

test('two isolated changes integrate without touching staged or unrelated user changes', async () => {
  const { repo, store } = setup();
  const [a, b] = await Promise.all([store.create(repo), store.create(repo)]);
  put(a.path, 'src/a.txt', fs.readFileSync(path.join(a.path, 'src/a.txt'), 'utf8').replace('line 2\n', 'agent A\n'));
  put(a.path, 'new 雪.txt', 'new file\n'); put(a.path, 'ignored/cache', 'do not integrate');
  put(b.path, 'src/b.txt', 'agent B\n');
  put(repo, 'src/a.txt', fs.readFileSync(path.join(repo, 'src/a.txt'), 'utf8').replace('line 19\n', 'user edit\n'));
  git(repo, 'add', 'src/a.txt'); put(repo, 'unrelated.txt', 'user content');
  const before = controlState(repo);
  const results = await Promise.all([store.integrate(a.id), store.integrate(b.id)]);
  assert.ok(results.every(result => result.status === 'applied'));
  assert.match(fs.readFileSync(path.join(repo, 'src/a.txt'), 'utf8'), /agent A[\s\S]*user edit/);
  assert.equal(fs.readFileSync(path.join(repo, 'src/b.txt'), 'utf8'), 'agent B\n');
  assert.equal(fs.readFileSync(path.join(repo, 'new 雪.txt'), 'utf8'), 'new file\n');
  assert.equal(fs.existsSync(path.join(repo, 'ignored/cache')), false);
  assert.equal(fs.readFileSync(path.join(repo, 'unrelated.txt'), 'utf8'), 'user content');
  assert.deepEqual(controlState(repo), before);
  assert.ok(fs.existsSync(results[0].patchFile));
  const originalWorkerFiles = files(a.path);
  put(repo, 'src/b.txt', 'later user edit\n');
  assert.equal((await store.integrate(b.id)).status, 'already_integrated');
  assert.equal(fs.readFileSync(path.join(repo, 'src/b.txt'), 'utf8'), 'later user edit\n');
  assert.deepEqual(files(a.path), originalWorkerFiles, 'integration retains the worker directory and changes');
  const listed = await store.list();
  assert.equal(listed.length, 2);
  assert.ok(listed.every(ws => ws.integration?.status === 'applied'));
  assert.ok(listed.find(ws => ws.id === a.id).changedFiles.includes('new 雪.txt'));
});

test('retained integration checkpoints survive Git pruning across reopened keep continuations', async () => {
  const { repo, parent, store } = setup();
  put(repo, '.gitattributes', '*.txt text eol=crlf\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'line endings');
  put(repo, 'inherited.txt', 'authorized dirty baseline\r\n');
  const controls = controlState(repo);
  const ws = await store.create(repo, { includeUncommitted: { reason: 'Authorized fixture baseline.' } });
  assert.notEqual(ws.baseCommit, controls.head.trim()); assert.deepEqual(controlState(repo), controls);
  const workerIndex = git(ws.path, 'rev-parse', '--path-format=absolute', '--git-path', 'index').trim();
  const originalIndex = fs.readFileSync(workerIndex);
  put(repo, 'user-only.txt', 'staged user content\r\n'); git(repo, 'add', 'user-only.txt');
  const before = controlState(repo);
  put(ws.path, 'src/b.txt', 'first\r\n'); put(ws.path, '雪.bin', Buffer.from([0, 255, 1]));
  fs.unlinkSync(path.join(ws.path, 'src/a.txt'));
  await store.integrate(ws.id);
  for (const n of [2, 3]) {
    const previousTree = store.get(ws.id).integration.tree;
    await new WorkspaceStore(parent).runAgent(ws.id, randomUUID(), async () => {
      put(ws.path, 'src/b.txt', `increment ${n}\r\n`); put(ws.path, '雪.bin', Buffer.from([0, 255, n]));
    }, { baseline: 'keep' });
    // Never prune the plugin/user repository: this is setup()'s disposable Git repository.
    git(repo, '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', 'prune', '--expire', 'now');
    assert.throws(() => git(repo, 'cat-file', '-e', previousTree), /Command failed/, 'the old tree really was collected');
    const result = await new WorkspaceStore(parent).integrate(ws.id);
    assert.deepEqual(result.changedFiles.sort(), ['src/b.txt', '雪.bin'].sort(), 'only the next increment is applied');
    assert.equal(fs.readFileSync(path.join(repo, 'src/b.txt'), 'utf8'), `increment ${n}\r\n`);
    assert.deepEqual(fs.readFileSync(path.join(repo, '雪.bin')), Buffer.from([0, 255, n]));
    assert.equal(fs.existsSync(path.join(repo, 'src/a.txt')), false);
    assert.deepEqual(controlState(repo), before);
    assert.deepEqual(fs.readFileSync(workerIndex), originalIndex);
    assert.equal(git(ws.path, 'rev-parse', 'HEAD').trim(), ws.baseCommit);
  }
  assert.equal((await store.integrate(ws.id)).status, 'already_integrated');
});

test('missing, malformed or mismatched retained checkpoints fail before parent writes', async () => {
  for (const damage of ['missing', 'malformed', 'mismatched']) {
    const { repo, store } = setup(); const ws = await store.create(repo);
    put(ws.path, 'src/b.txt', 'first\n'); await store.integrate(ws.id);
    const integration = store.get(ws.id).integration;
    assert.ok(integration.checkpointFile, 'new integrations must retain a recoverable checkpoint');
    if (damage === 'missing') fs.unlinkSync(integration.checkpointFile);
    else fs.writeFileSync(integration.checkpointFile, damage === 'malformed' ? 'not a Git patch\n' : '');
    await store.runAgent(ws.id, randomUUID(), async () => put(ws.path, 'src/b.txt', 'second\n'), { baseline: 'keep' });
    const workerIndex = git(ws.path, 'rev-parse', '--path-format=absolute', '--git-path', 'index').trim();
    const originalIndex = fs.readFileSync(workerIndex);
    const before = { files: files(repo), git: controlState(repo), workerFiles: files(ws.path) };
    await assert.rejects(store.integrate(ws.id), /checkpoint/i, damage);
    assert.deepEqual({ files: files(repo), git: controlState(repo), workerFiles: files(ws.path) }, before);
    assert.deepEqual(fs.readFileSync(workerIndex), originalIndex);
    assert.equal(git(ws.path, 'rev-parse', 'HEAD').trim(), ws.baseCommit);
    assert.deepEqual(store.get(ws.id).integration, integration);
    assert.equal(fs.readFileSync(path.join(ws.path, 'src/b.txt'), 'utf8'), 'second\n');
  }
});

test('legacy integration records remain usable and gain a checkpoint on the next integration', async () => {
  const { repo, parent, store } = setup(); const ws = await store.create(repo);
  put(ws.path, 'src/b.txt', 'first\n'); await store.integrate(ws.id);
  const record = path.join(`${parent}.subagents`, 'workspaces', ws.id, 'workspace.json');
  const legacy = JSON.parse(fs.readFileSync(record));
  if (legacy.integration.checkpointFile) fs.unlinkSync(legacy.integration.checkpointFile);
  delete legacy.integration.checkpointFile; fs.writeFileSync(record, JSON.stringify(legacy));
  const reopened = new WorkspaceStore(parent);
  await reopened.runAgent(ws.id, randomUUID(), async () => {
    // Returning to the baseline creates an intentionally empty checkpoint patch.
    put(ws.path, 'src/b.txt', 'original B\n');
  }, { baseline: 'keep' });
  await reopened.integrate(ws.id);
  const checkpoint = reopened.get(ws.id).integration.checkpointFile;
  assert.ok(checkpoint); assert.equal(fs.readFileSync(checkpoint).length, 0);
  await reopened.runAgent(ws.id, randomUUID(), async () => put(ws.path, 'src/b.txt', 'third\n'), { baseline: 'keep' });
  await reopened.integrate(ws.id);
  assert.equal(fs.readFileSync(path.join(repo, 'src/b.txt'), 'utf8'), 'third\n');
});

test('overlapping changes reject the entire patch, including otherwise clean new files', async () => {
  const { repo, store } = setup(); const ws = await store.create(repo);
  put(ws.path, 'src/b.txt', 'agent B\n'); put(ws.path, 'new.txt', 'would apply\n');
  put(repo, 'src/b.txt', 'user B\n'); put(repo, 'untracked.txt', 'keep\n');
  const before = { files: files(repo), git: controlState(repo) };
  await assert.rejects(store.integrate(ws.id), /conflict|patch.*failed/i);
  assert.deepEqual({ files: files(repo), git: controlState(repo) }, before);
  assert.equal(fs.existsSync(ws.path), true);
  assert.equal(store.get(ws.id).integration, undefined, 'a preflight rejection must not record success');
});

test('an existing untracked or ignored file is not overwritten by an added file', async () => {
  for (const name of ['collision.txt', 'ignored/collision.txt']) {
    const { repo, store } = setup(); const ws = await store.create(repo);
    put(ws.path, name, 'worker'); git(ws.path, 'add', '-f', name);
    put(repo, name, 'user');
    const before = files(repo);
    // Ignored files are not selected solely because a child force-staged them.
    const result = await store.integrate(ws.id).catch(error => error);
    if (name.startsWith('ignored/')) assert.equal(result.status, 'no_changes');
    else assert.match(result.message, /conflict|exists/i);
    assert.deepEqual(files(repo), before);
  }
});

test('binary files, tracked deletions and CRLF survive integration without index changes', async () => {
  const { repo, store } = setup();
  put(repo, '.gitattributes', '*.txt text eol=crlf\n');
  put(repo, 'src/a.txt', fs.readFileSync(path.join(repo, 'src/a.txt'), 'utf8').replace(/\n/g, '\r\n'));
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'line endings');
  const ws = await store.create(repo);
  const text = fs.readFileSync(path.join(ws.path, 'src/a.txt'), 'utf8');
  put(ws.path, 'src/a.txt', text.replace('line 2', 'worker'));
  put(repo, 'src/a.txt', fs.readFileSync(path.join(repo, 'src/a.txt'), 'utf8').replace('line 19', 'user'));
  fs.unlinkSync(path.join(ws.path, 'src/b.txt'));
  put(ws.path, 'blob.bin', Buffer.from([0, 255, 17, 0, 13, 10]));
  const before = controlState(repo);
  await store.integrate(ws.id);
  const actual = fs.readFileSync(path.join(repo, 'src/a.txt'), 'utf8');
  assert.match(actual, /worker\r\n/); assert.match(actual, /user\r\n/);
  assert.equal(actual.replace(/\r\n/g, '').includes('\n'), false);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'blob.bin')), Buffer.from([0, 255, 17, 0, 13, 10]));
  assert.equal(fs.existsSync(path.join(repo, 'src/b.txt')), false);
  assert.ok(fs.existsSync(ws.path)); assert.deepEqual(controlState(repo), before);
});

test('post-integration edits and changed worker HEAD require inspection, not another apply', async () => {
  const { repo, store } = setup(); const ws = await store.create(repo);
  put(ws.path, 'src/b.txt', 'first\n'); await store.integrate(ws.id);
  put(ws.path, 'src/b.txt', 'second\n');
  await assert.rejects(store.integrate(ws.id), /integrated.*changed|changed.*integrat/i);
  assert.equal(fs.readFileSync(path.join(repo, 'src/b.txt'), 'utf8'), 'first\n');
  const other = await store.create(repo);
  put(other.path, 'src/b.txt', 'committed\n'); git(other.path, 'add', '.'); git(other.path, 'commit', '-qm', 'unexpected commit');
  await assert.rejects(store.integrate(other.id), /HEAD|baseline/i);
});

test('hooks are not run by creation and configured content filters fail closed', async () => {
  const { root, repo, store } = setup();
  const marker = path.join(root, 'hook-ran');
  put(repo, '.git/hooks/post-checkout', `#!/bin/sh\nprintf hook > '${marker.replace(/\\/g, '/')}'\n`);
  fs.chmodSync(path.join(repo, '.git/hooks/post-checkout'), 0o755);
  const ws = await store.create(repo);
  assert.equal(fs.existsSync(marker), false);
  put(ws.path, '.gitattributes', '*.txt filter=custom\n');
  const filterMarker = path.join(root, 'filter-ran');
  git(repo, 'config', 'filter.custom.clean', `printf filter > '${filterMarker.replace(/\\/g, '/')}'; cat`);
  put(ws.path, 'src/b.txt', 'filtered\n');
  const before = files(repo);
  await assert.rejects(store.integrate(ws.id), /filter.*unsupported|unsupported.*filter/i);
  assert.deepEqual(files(repo), before);
  const listed = (await store.list()).find(item => item.id === ws.id);
  assert.match(listed.error, /filter.*unsupported|unsupported.*filter/i);
  assert.equal(fs.existsSync(filterMarker), false, 'listing must not execute clean filters either');
  put(repo, '.gitattributes', '*.txt filter=custom\n');
  put(repo, 'src/b.txt', 'dirty parent\n');
  await assert.rejects(store.create(repo), /filter.*unsupported|unsupported.*filter/i);
  assert.equal(fs.existsSync(filterMarker), false, 'dirty-parent inspection must not execute clean filters');
});

test('workspace Git commands do not execute a configured fsmonitor hook', async () => {
  const { root, repo, store } = setup();
  const marker = path.join(root, 'fsmonitor-ran');
  const script = path.join(repo, '.git/hooks/test-fsmonitor');
  put(repo, '.git/hooks/test-fsmonitor', `#!/bin/sh\nprintf ran > '${marker.replace(/\\/g, '/')}'\nprintf 'token\\0'\n`);
  fs.chmodSync(script, 0o755);
  git(repo, 'config', 'core.fsmonitor', script.replace(/\\/g, '/'));
  const ws = await store.create(repo);
  await store.list();
  put(ws.path, 'src/b.txt', 'worker\n'); await store.integrate(ws.id);
  assert.equal(fs.existsSync(marker), false);
});

test('sparse checkout enabled after creation is refused rather than integrating missing files as deletions', async () => {
  const { repo, store } = setup(); const ws = await store.create(repo);
  git(ws.path, 'config', 'core.sparseCheckout', 'true');
  fs.unlinkSync(path.join(ws.path, 'src/b.txt'));
  const before = files(repo);
  await assert.rejects(store.integrate(ws.id), /sparse/i);
  assert.deepEqual(files(repo), before);
});

test('unfinished integration records fail closed across reopen', async () => {
  const { repo, parent, store } = setup(); const ws = await store.create(repo);
  const record = path.join(`${parent}.subagents`, 'workspaces', ws.id, 'workspace.json');
  const data = JSON.parse(fs.readFileSync(record, 'utf8'));
  data.integration = { status: 'applying', tree: ws.baseCommit, patchFile: 'retained.patch', time: Date.now() };
  fs.writeFileSync(record, JSON.stringify(data));
  await assert.rejects(new WorkspaceStore(parent).integrate(ws.id), /inspect|uncertain|unfinished/i);
});
