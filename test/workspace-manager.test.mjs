import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { AgentManager } from '../dist/manager.js';
import { defaultRoles } from '../dist/roles.js';
import { waitUntil, processAlive } from '../dist/storage.js';

const fixture = fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url));
const launch = { command: process.execPath, args: [fixture] };
const output = path.resolve('.test-output'); fs.mkdirSync(output, { recursive: true });
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
function setup(t) {
  const root = fs.mkdtempSync(path.join(output, 'workspace-manager-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(repo, 'src')); fs.writeFileSync(path.join(repo, 'src/base.txt'), 'base\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'fixture');
  const parent = path.join(root, 'parent.jsonl'); fs.writeFileSync(parent, '{}\n');
  const manager = new AgentManager(parent, launch);
  t.after(async () => {
    for (const state of manager.list()) if (processAlive(state.workerPid)) await manager.close(state.id);
  });
  return { repo, parent, manager };
}
const complete = (manager, id) => waitUntil('worker completion and lease release', () => {
  const state = manager.get(id);
  return state.phase === 'completed' && !processAlive(state.workerPid) ? state : undefined;
}, 15_000);
const fileTask = (file, content) => `FILE ${JSON.stringify({ file, ...(content === undefined ? {} : { content }) })}`;

test('managed cwd reaches the real child and survives manager reopen', { timeout: 30_000 }, async t => {
  const { repo, parent, manager } = setup(t);
  const ws = await manager.workspaces.create(path.join(repo, 'src'));
  const child = await manager.spawn('worker', defaultRoles.worker, repo, 'CWD', ws.id);
  const first = await complete(manager, child.id);
  assert.equal(first.cwd, ws.cwd); assert.equal(first.text, ws.cwd); assert.equal(first.workspace, ws.id);
  const fresh = new AgentManager(parent, launch);
  await fresh.send(first.id, 'CWD');
  const second = await complete(fresh, first.id);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.workspace, ws.id);
  assert.equal((await fresh.workspaces.list())[0].id, ws.id);
});

test('two isolated workers, independent reviewers and integration share the correct changes', { timeout: 40_000 }, async t => {
  const { repo, manager } = setup(t);
  const [a, b] = await Promise.all([manager.workspaces.create(repo), manager.workspaces.create(repo)]);
  const [wa, wb] = await Promise.all([
    manager.spawn('worker', defaultRoles.worker, repo, fileTask('a.txt', 'A\n'), a.id),
    manager.spawn('worker', defaultRoles.worker, repo, fileTask('b.txt', 'B\n'), b.id),
  ]);
  const [first, second] = await Promise.all([complete(manager, wa.id), complete(manager, wb.id)]);
  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal(fs.existsSync(path.join(repo, 'a.txt')), false);
  assert.equal(fs.existsSync(path.join(a.path, 'b.txt')), false);
  const [ra, rb] = await Promise.all([
    manager.spawn('reviewer', defaultRoles.reviewer, repo, fileTask('a.txt'), a.id),
    manager.spawn('reviewer', defaultRoles.reviewer, repo, fileTask('b.txt'), b.id),
  ]);
  const [reviewA, reviewB] = await Promise.all([complete(manager, ra.id), complete(manager, rb.id)]);
  assert.equal(reviewA.text, 'A\n'); assert.equal(reviewB.text, 'B\n');
  assert.notEqual(reviewA.sessionId, first.sessionId); assert.equal(reviewA.cwd, first.cwd);
  const result = await Promise.all([manager.workspaces.integrate(a.id), manager.workspaces.integrate(b.id)]);
  assert.ok(result.every(item => item.status === 'applied'));
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'A\n');
  assert.equal(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8'), 'B\n');
  for (const id of [wa.id, wb.id, ra.id, rb.id]) await assert.rejects(manager.send(id, 'CWD'), /integrat.*baseline|baseline.*disabled/i);
  await assert.rejects(manager.spawn('worker', defaultRoles.worker, repo, 'CWD', a.id), /integrat/i);
  assert.equal(manager.list().length, 4, 'refused starts must not leave half-created instances');
  assert.ok(manager.list().every(agent => agent.runCount === 1));
});

test('a reviewer holds the workspace against tool and raw cwd starts while siblings continue', { timeout: 40_000 }, async t => {
  const { repo, manager } = setup(t);
  const ws = await manager.workspaces.create(repo);
  const worker = await manager.spawn('worker', defaultRoles.worker, repo, 'CWD', ws.id);
  await complete(manager, worker.id);
  const reviewer = await manager.spawn('reviewer', defaultRoles.reviewer, repo, 'HOLD review', ws.id);
  await assert.rejects(manager.send(worker.id, 'new task'), /occupied/);
  await assert.rejects(manager.spawn('worker', defaultRoles.worker, repo, 'CWD', ws.id), /occupied/);
  await assert.rejects(manager.spawn('worker', defaultRoles.worker, ws.path, 'CWD'), /workspace.*instead of cwd/i);
  await assert.rejects(manager.workspaces.integrate(ws.id), /occupied/);
  assert.deepEqual((await manager.workspaces.list())[0].occupiedBy, [reviewer.id]);
  const other = await manager.workspaces.create(repo);
  const sibling = await manager.spawn('worker', defaultRoles.worker, repo, 'CWD', other.id);
  assert.equal((await complete(manager, sibling.id)).text, other.path);
  await manager.send(reviewer.id, 'review complete'); await complete(manager, reviewer.id);
  await manager.send(worker.id, 'CWD');
  assert.equal((await complete(manager, worker.id)).runCount, 2);
});

test('racing managers cannot start two owners in the same managed workspace', { timeout: 30_000 }, async t => {
  const { repo, parent, manager } = setup(t); const ws = await manager.workspaces.create(repo);
  const other = new AgentManager(parent, launch);
  const outcomes = await Promise.allSettled([
    manager.spawn('worker', defaultRoles.worker, repo, 'HOLD first', ws.id),
    other.spawn('reviewer', defaultRoles.reviewer, repo, 'HOLD second', ws.id),
  ]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(item => item.status === 'rejected').length, 1);
  assert.equal(manager.list().length, 1);
});

test('workspace occupation survives the original controller exiting', { timeout: 30_000 }, async t => {
  const { repo, parent, manager } = setup(t); const ws = await manager.workspaces.create(repo);
  const module = new URL('../dist/manager.js', import.meta.url).href;
  const code = `const {AgentManager}=await import(${JSON.stringify(module)});const m=new AgentManager(${JSON.stringify(parent)},${JSON.stringify(launch)});console.log(JSON.stringify(await m.spawn('worker',{description:'test',instructions:'test'},${JSON.stringify(repo)},'HOLD detached',${JSON.stringify(ws.id)})));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { timeout: 15_000 });
  const child = JSON.parse(stdout);
  assert.ok(processAlive(child.workerPid));
  await assert.rejects(manager.spawn('reviewer', defaultRoles.reviewer, repo, 'CWD', ws.id), /occupied/);
  await assert.rejects(manager.workspaces.integrate(ws.id), /occupied/);
  await manager.send(child.id, 'finished after parent exit');
  assert.equal((await complete(manager, child.id)).text, 'finished after parent exit');
});

test('explicit keep resumes the same session and integrates only the subsequent increment', { timeout: 40_000 }, async t => {
  const { repo, parent, manager } = setup(t); const ws = await manager.workspaces.create(repo);
  const worker = await manager.spawn('worker', defaultRoles.worker, repo, fileTask('src/base.txt', 'first\n'), ws.id);
  const first = await complete(manager, worker.id); await manager.workspaces.integrate(ws.id);
  fs.writeFileSync(path.join(repo, 'parent-only.txt'), 'do not silently inherit');
  await assert.rejects(manager.send(worker.id, 'CWD'), /baseline/i);
  const fresh = new AgentManager(parent, launch);
  await fresh.send(worker.id, fileTask('src/base.txt', 'second\n'), 'steer', { baseline: 'keep' });
  const resumed = await complete(fresh, worker.id);
  assert.equal(resumed.sessionId, first.sessionId); assert.equal(resumed.sessionFile, first.sessionFile);
  assert.equal(fs.existsSync(path.join(ws.path, 'parent-only.txt')), false);
  assert.equal(git(ws.path, 'rev-parse', 'HEAD').trim(), ws.baseCommit);
  const native = JSON.parse(fs.readFileSync(resumed.sessionFile, 'utf8'));
  assert.match(native.messages.filter(m => m.role === 'user').at(-1).content, /Workspace baseline/);
  const reviewer = await fresh.spawn('reviewer', defaultRoles.reviewer, repo, fileTask('src/base.txt'), ws.id);
  assert.equal((await complete(fresh, reviewer.id)).text, 'second\n');
  const result = await fresh.workspaces.integrate(ws.id);
  assert.equal(result.status, 'applied'); assert.deepEqual(result.changedFiles, ['src/base.txt']);
  assert.equal(fs.readFileSync(path.join(repo, 'src/base.txt'), 'utf8'), 'second\n');
  assert.equal((await fresh.workspaces.integrate(ws.id)).status, 'already_integrated');
  await assert.rejects(fresh.send(worker.id, 'CWD'), /baseline/i);
});

test('sync inherits confirmed parent changes, preserves ignored files and requires every old instance to acknowledge', { timeout: 50_000 }, async t => {
  const { repo, parent, manager } = setup(t);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored/\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'ignored fixture');
  const ws = await manager.workspaces.create(repo);
  const worker = await manager.spawn('worker', defaultRoles.worker, repo, fileTask('src/base.txt', 'first\n'), ws.id);
  const first = await complete(manager, worker.id);
  fs.writeFileSync(path.join(ws.path, 'obsolete.txt'), 'already integrated then removed');
  const reviewer = await manager.spawn('reviewer', defaultRoles.reviewer, repo, fileTask('src/base.txt'), ws.id);
  await complete(manager, reviewer.id);
  await manager.workspaces.integrate(ws.id);
  fs.mkdirSync(path.join(ws.path, 'ignored')); fs.writeFileSync(path.join(ws.path, 'ignored/cache'), 'preserve cache');
  fs.unlinkSync(path.join(repo, 'obsolete.txt')); fs.writeFileSync(path.join(repo, 'parent-new.txt'), 'authorized parent content');
  const before = { head: git(repo, 'rev-parse', 'HEAD'), refs: git(repo, 'show-ref'), index: fs.readFileSync(path.join(repo, '.git/index')).toString('base64') };
  await assert.rejects(manager.send(worker.id, 'CWD', 'steer', { baseline: 'sync' }), /uncommitted|authoriz/i);
  assert.equal(fs.existsSync(path.join(ws.path, 'parent-new.txt')), false);
  await manager.send(worker.id, fileTask('parent-new.txt'), 'steer', { baseline: 'sync', includeUncommitted: { reason: 'User confirmed all parent task changes.' } });
  const resumed = await complete(manager, worker.id);
  assert.equal(resumed.text, 'authorized parent content'); assert.equal(resumed.sessionId, first.sessionId);
  const synced = new AgentManager(parent, launch).workspaces.get(ws.id);
  assert.notEqual(synced.baseCommit, ws.baseCommit); assert.equal(synced.sync.status, 'applied');
  assert.equal(synced.snapshotReason, 'User confirmed all parent task changes.');
  const priorRecord = JSON.parse(fs.readFileSync(path.join(path.dirname(synced.sync.patchFile), 'workspace.before.json'), 'utf8'));
  assert.equal(priorRecord.baseCommit, ws.baseCommit);
  assert.equal(fs.readFileSync(path.join(ws.path, 'ignored/cache'), 'utf8'), 'preserve cache');
  assert.equal(fs.existsSync(path.join(ws.path, 'obsolete.txt')), false);
  assert.equal(git(ws.path, 'status', '--porcelain'), '');
  assert.deepEqual({ head: git(repo, 'rev-parse', 'HEAD'), refs: git(repo, 'show-ref'), index: fs.readFileSync(path.join(repo, '.git/index')).toString('base64') }, before);
  const native = JSON.parse(fs.readFileSync(resumed.sessionFile, 'utf8'));
  const prompt = native.messages.filter(m => m.role === 'user').at(-1).content;
  assert.match(prompt, /Workspace baseline/); assert.match(prompt, /parent-new.txt/); assert.match(prompt, /obsolete.txt/);
  await assert.rejects(manager.send(reviewer.id, fileTask('parent-new.txt')), /baseline/i);
  await manager.send(worker.id, fileTask('parent-new.txt', 'next change'));
  await complete(manager, worker.id);
  assert.equal((await manager.workspaces.integrate(ws.id)).status, 'applied');
  assert.equal(fs.readFileSync(path.join(repo, 'parent-new.txt'), 'utf8'), 'next change');
  await manager.send(worker.id, 'CWD', 'steer', { baseline: 'sync', includeUncommitted: { reason: 'Approved the next integrated increment.' } });
  await complete(manager, worker.id);
  assert.deepEqual(manager.workspaces.get(ws.id).sync.changedFiles, [], 'the latest sync need not repeat earlier deletions');
  await assert.rejects(manager.send(reviewer.id, fileTask('parent-new.txt')), /baseline/i);
  await manager.send(reviewer.id, fileTask('parent-new.txt'), 'steer', { baseline: 'keep' });
  const rereview = await complete(manager, reviewer.id);
  assert.equal(rereview.text, 'next change');
  const rereviewNative = JSON.parse(fs.readFileSync(rereview.sessionFile, 'utf8'));
  assert.match(rereviewNative.messages.filter(m => m.role === 'user').at(-1).content, /obsolete.txt/,
    'an old instance must learn about intervening deletions, not just the latest tree diff');
});

test('sync refuses unintegrated or staged-only work without changing files or the native session', { timeout: 40_000 }, async t => {
  const { repo, manager } = setup(t); const ws = await manager.workspaces.create(repo);
  const worker = await manager.spawn('worker', defaultRoles.worker, repo, fileTask('src/base.txt', 'first\n'), ws.id);
  const first = await complete(manager, worker.id); await manager.workspaces.integrate(ws.id);
  const options = { baseline: 'sync', includeUncommitted: { reason: 'Approved parent changes.' } };
  fs.writeFileSync(path.join(ws.path, 'not-integrated.txt'), 'do not lose this');
  await assert.rejects(manager.send(worker.id, 'CWD', 'steer', options), /unintegrated/i);
  assert.equal(fs.readFileSync(path.join(ws.path, 'not-integrated.txt'), 'utf8'), 'do not lose this');
  fs.unlinkSync(path.join(ws.path, 'not-integrated.txt'));
  fs.writeFileSync(path.join(ws.path, 'src/base.txt'), 'staged-only content\n'); git(ws.path, 'add', '.');
  fs.writeFileSync(path.join(ws.path, 'src/base.txt'), 'first\n');
  const staged = git(ws.path, 'show', ':src/base.txt');
  await assert.rejects(manager.send(worker.id, 'CWD', 'steer', options), /staged/i);
  assert.equal(git(ws.path, 'show', ':src/base.txt'), staged);
  assert.equal(git(ws.path, 'rev-parse', 'HEAD').trim(), ws.baseCommit);
  assert.equal(manager.get(worker.id).runCount, 1); assert.equal(manager.get(worker.id).sessionId, first.sessionId);
});

test('sync refuses a live instance, missing native session, and an unfinished sync journal', { timeout: 40_000 }, async t => {
  const { repo, parent, manager } = setup(t); const ws = await manager.workspaces.create(repo);
  const worker = await manager.spawn('worker', defaultRoles.worker, repo, 'HOLD', ws.id);
  await assert.rejects(manager.send(worker.id, 'CWD', 'steer', { baseline: 'sync' }), /running|occupied/i);
  await manager.send(worker.id, 'done'); const first = await complete(manager, worker.id);
  fs.writeFileSync(path.join(ws.path, 'src/base.txt'), 'first\n'); await manager.workspaces.integrate(ws.id);
  const content = fs.readFileSync(path.join(ws.path, 'src/base.txt'), 'utf8');
  fs.renameSync(first.sessionFile, `${first.sessionFile}.retained`);
  await assert.rejects(manager.send(worker.id, 'CWD', 'steer', { baseline: 'sync', includeUncommitted: { reason: 'Approved.' } }), /Original session file is missing/);
  assert.equal(fs.readFileSync(path.join(ws.path, 'src/base.txt'), 'utf8'), content);
  assert.equal(git(ws.path, 'rev-parse', 'HEAD').trim(), ws.baseCommit);
  fs.renameSync(`${first.sessionFile}.retained`, first.sessionFile);
  const record = path.join(`${parent}.subagents`, 'workspaces', ws.id, 'workspace.json');
  const data = JSON.parse(fs.readFileSync(record, 'utf8')); data.sync = { status: 'applying' }; fs.writeFileSync(record, JSON.stringify(data));
  await assert.rejects(manager.send(worker.id, 'CWD', 'steer', { baseline: 'keep' }), /unfinished|uncertain|inspect/i);
  await assert.rejects(manager.workspaces.integrate(ws.id), /unfinished|uncertain|inspect/i);
  assert.equal(manager.get(worker.id).runCount, 1);
});

test('Pi identity mismatch is rejected before sync without changing either Git tree or creating a run', { timeout: 30_000 }, async t => {
  const { repo, manager } = setup(t); const ws = await manager.workspaces.create(repo);
  const child = await manager.spawn('worker', defaultRoles.worker, repo, 'REMEMBER original-token', ws.id);
  const first = await complete(manager, child.id);
  const saved = fs.readFileSync(first.sessionFile);
  const foreign = Buffer.from(JSON.stringify({ ...JSON.parse(saved), id: 'foreign-session' }));
  fs.writeFileSync(first.sessionFile, foreign);
  fs.writeFileSync(path.join(repo, 'src/base.txt'), 'changed parent\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'parent update');
  const index = git(ws.path, 'rev-parse', '--path-format=absolute', '--git-path', 'index').trim();
  const snapshot = () => ({
    workspace: manager.workspaces.get(ws.id), head: git(ws.path, 'rev-parse', 'HEAD'), index: fs.readFileSync(index),
    content: fs.readFileSync(path.join(ws.path, 'src/base.txt')),
    parentHead: git(repo, 'rev-parse', 'HEAD'), parentRefs: git(repo, 'show-ref'), parentIndex: fs.readFileSync(path.join(repo, '.git/index')),
    parentContent: fs.readFileSync(path.join(repo, 'src/base.txt')),
    spec: fs.readFileSync(path.join(manager.root, child.id, 'spec.json')), runs: fs.readdirSync(path.join(manager.root, child.id, 'runs')),
  });
  const before = snapshot();
  let error;
  try { await manager.send(child.id, 'MUST NOT EXECUTE', 'steer', { baseline: 'sync' }); } catch (caught) { error = caught; }
  await waitUntil('no worker after refusal', () => !fs.existsSync(path.join(manager.root, child.id, 'owner.lock')), 10_000);
  assert.deepEqual(snapshot(), before, 'identity refusal must precede Git changes and new-run creation');
  assert.match(error?.message ?? '', /different session/);
  assert.match(error.message, /no synchronization was performed/);
  assert.deepEqual(fs.readFileSync(first.sessionFile), foreign, 'preflight must not repair or rewrite the native file');
  assert.equal(manager.get(child.id).runId, first.runId);
  assert.equal(manager.getResult(child.id, first.runId).text, 'OK');

  fs.writeFileSync(first.sessionFile, saved);
  await manager.send(child.id, 'RECALL', 'steer', { baseline: 'sync' });
  const resumed = await complete(manager, child.id);
  assert.equal(resumed.sessionId, first.sessionId); assert.equal(resumed.text, 'original-token');
  assert.equal(resumed.runCount, 2); assert.notEqual(resumed.runId, first.runId);
  assert.equal(fs.readFileSync(path.join(ws.path, 'src/base.txt'), 'utf8'), 'changed parent\n');
  assert.equal(manager.workspaces.get(ws.id).sync.status, 'applied');
});

test('sync rejects a sparse parent even when the managed worktree itself is full', { timeout: 30_000 }, async t => {
  const { repo, manager } = setup(t); const ws = await manager.workspaces.create(repo);
  const worker = await manager.spawn('worker', defaultRoles.worker, repo, fileTask('src/base.txt', 'first\n'), ws.id);
  await complete(manager, worker.id); await manager.workspaces.integrate(ws.id);
  git(repo, 'config', 'extensions.worktreeConfig', 'true');
  git(repo, 'config', '--worktree', 'core.sparseCheckout', 'true');
  assert.notEqual(git(ws.path, 'config', '--default=false', 'core.sparseCheckout').trim(), 'true');
  fs.unlinkSync(path.join(repo, 'src/base.txt'));
  await assert.rejects(manager.send(worker.id, 'CWD', 'steer', { baseline: 'sync', includeUncommitted: { reason: 'Approved task state, not a sparse deletion.' } }), /sparse/i);
  assert.equal(fs.readFileSync(path.join(ws.path, 'src/base.txt'), 'utf8'), 'first\n');
  assert.equal(manager.get(worker.id).runCount, 1);
});

test('sync preserves CRLF/binary content and refuses to overwrite an ignored collision', { timeout: 40_000 }, async t => {
  const { repo, manager } = setup(t);
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt text eol=crlf\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored/\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'attributes');
  const ws = await manager.workspaces.create(repo);
  const worker = await manager.spawn('worker', defaultRoles.worker, repo, 'CWD', ws.id); await complete(manager, worker.id);
  fs.writeFileSync(path.join(ws.path, 'src/base.txt'), 'integrated\r\n'); await manager.workspaces.integrate(ws.id);
  fs.writeFileSync(path.join(repo, 'src/base.txt'), 'parent\r\n');
  fs.writeFileSync(path.join(repo, 'bytes.bin'), Buffer.from([0, 255, 12, 13, 10]));
  const options = { baseline: 'sync', includeUncommitted: { reason: 'Approved parent content.' } };
  await manager.send(worker.id, 'CWD', 'steer', options); await complete(manager, worker.id);
  assert.equal(fs.readFileSync(path.join(ws.path, 'src/base.txt'), 'utf8'), 'parent\r\n');
  assert.deepEqual(fs.readFileSync(path.join(ws.path, 'bytes.bin')), Buffer.from([0, 255, 12, 13, 10]));
  fs.mkdirSync(path.join(ws.path, 'ignored')); fs.writeFileSync(path.join(ws.path, 'ignored/keep.txt'), 'local cache');
  fs.mkdirSync(path.join(repo, 'ignored')); fs.writeFileSync(path.join(repo, 'ignored/keep.txt'), 'parent new tracked file');
  git(repo, 'add', '-f', 'ignored/keep.txt'); git(repo, 'commit', '-qm', 'new tracked path');
  const baseline = manager.workspaces.get(ws.id).baseCommit;
  await assert.rejects(manager.send(worker.id, 'CWD', 'steer', options), /already exists|patch|apply/i);
  assert.equal(fs.readFileSync(path.join(ws.path, 'ignored/keep.txt'), 'utf8'), 'local cache');
  assert.equal(manager.workspaces.get(ws.id).baseCommit, baseline);
  assert.equal(manager.get(worker.id).runCount, 2);
});

test('sync refuses to remove the original child cwd', { timeout: 25_000 }, async t => {
  const { repo, manager } = setup(t); const ws = await manager.workspaces.create(path.join(repo, 'src'));
  const worker = await manager.spawn('worker', defaultRoles.worker, repo, 'CWD', ws.id); await complete(manager, worker.id);
  fs.unlinkSync(path.join(repo, 'src/base.txt'));
  await assert.rejects(manager.send(worker.id, 'CWD', 'steer', { baseline: 'sync', includeUncommitted: { reason: 'Authorized deletion, but do not break the original cwd.' } }), /cwd|directory|baseline/i);
  assert.equal(fs.readFileSync(path.join(ws.cwd, 'base.txt'), 'utf8'), 'base\n');
  assert.equal(git(ws.path, 'rev-parse', 'HEAD').trim(), ws.baseCommit);
  assert.equal(manager.get(worker.id).runCount, 1);
});

test('a stale operation lock fails closed without deleting workspaces or starting a child', { timeout: 15_000 }, async t => {
  const { repo, parent, manager } = setup(t); const ws = await manager.workspaces.create(repo);
  const lock = path.join(`${parent}.subagents`, 'workspaces', ws.id, 'operation.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999999, operation: 'crashed' }));
  await assert.rejects(manager.spawn('worker', defaultRoles.worker, repo, 'CWD', ws.id), /stale lock|busy/);
  await assert.rejects(manager.workspaces.integrate(ws.id), /stale lock|busy/);
  assert.equal(fs.existsSync(lock), true); assert.equal(fs.existsSync(ws.path), true);
  assert.equal(manager.list().length, 0);
});
