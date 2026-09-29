// Real temporary Git repositories and deterministic Codex/Pi CLIs; no model or account access.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AgentManager } from '../dist/manager.js';
import { processAlive, waitUntil, readJson } from '../dist/storage.js';
const fixture = fileURLToPath(new URL('./fixtures/codex.mjs', import.meta.url));
const pi = fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url));
const role = { cli: 'codex', description: 'test', instructions: 'Only the assigned fixture task', model: 'gpt-6-luna' };
const piRole = { description: 'reviewer', instructions: 'Inspect the assigned files' };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
const output = path.resolve('.test-output'); fs.mkdirSync(output, { recursive: true });
const fileTask = (file, content) => `FILE ${JSON.stringify({ file, ...(content === undefined ? {} : { content }) })}`;
function setup(t, flags = []) {
  const root = fs.mkdtempSync(path.join(output, 'codex-workspace-'));
  const repo = path.join(root, 'repo'), home = path.join(root, 'home'), parent = path.join(root, 'parent.jsonl');
  fs.mkdirSync(repo); fs.mkdirSync(home); fs.writeFileSync(path.join(home, 'fixture-home'), ''); fs.writeFileSync(parent, '{}\n');
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(repo, 'src')); fs.writeFileSync(path.join(repo, 'src/base.txt'), 'base\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored/\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'fixture');
  const launch = { command: process.execPath, args: [pi] }, options = { launch: { command: process.execPath, args: [fixture, ...flags] }, home };
  const manager = new AgentManager(parent, launch, options);
  t.after(async () => { for (const state of manager.list()) if (processAlive(state.workerPid)) await manager.close(state.id); });
  const done = (id, phase = 'completed') => waitUntil('Codex completion and lease release', () => {
    const s = manager.get(id); return s.phase === phase && !processAlive(s.workerPid) ? s : undefined;
  }, 15_000);
  const requests = () => readJsonLines(path.join(home, 'requests.jsonl'));
  return { repo, home, parent, manager, done, requests, launch, options };
}
function readJsonLines(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; }
function baseline(ws) {
  const index = git(ws.path, 'rev-parse', '--path-format=absolute', '--git-path', 'index').trim();
  return { head: git(ws.path, 'rev-parse', 'HEAD'), index: fs.readFileSync(index).toString('base64'), content: fs.readFileSync(path.join(ws.path, 'src/base.txt'), 'utf8') };
}
const sync = { baseline: 'sync', includeUncommitted: { reason: 'The user authorized all parent changes for this fixture.' } };

test('Codex managed cwd inherits authorized files and resumes the same thread after controller reopen', { timeout: 30_000 }, async t => {
  const { repo, home, manager, done, parent, launch, options, requests } = setup(t);
  fs.writeFileSync(path.join(repo, 'src/base.txt'), 'authorized snapshot\n');
  const head = git(repo, 'rev-parse', 'HEAD'), index = fs.readFileSync(path.join(repo, '.git/index'));
  const ws = await manager.workspaces.create(path.join(repo, 'src'), { includeUncommitted: { reason: 'User approved all working files.' } });
  const started = await manager.spawn('codex-worker', role, repo, fileTask('base.txt'), ws.id);
  const first = await done(started.id);
  assert.equal(first.cwd, ws.cwd); assert.equal(first.text, 'authorized snapshot\n'); assert.equal(first.workspace, ws.id);
  const reopened = new AgentManager(parent, launch, { ...options, home: path.join(home, 'not-the-original-home') });
  await reopened.send(first.id, 'CWD'); const second = await done(first.id);
  assert.deepEqual(second.session, first.session); assert.equal(second.text, ws.cwd); assert.equal(second.sessionFile, undefined);
  assert.equal(requests().filter(r => r.method === 'thread/start').length, 1);
  assert.equal(requests().filter(r => r.method === 'thread/resume').length, 1);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head); assert.deepEqual(fs.readFileSync(path.join(repo, '.git/index')), index);
});

test('Codex parallel worktrees isolate writes and allow mixed-CLI review before integration', { timeout: 40_000 }, async t => {
  const { repo, manager, done } = setup(t);
  const [a, b] = await Promise.all([manager.workspaces.create(repo), manager.workspaces.create(repo)]);
  const [wa, wb] = await Promise.all([
    manager.spawn('codex-worker', role, repo, fileTask('a.txt', 'A\n'), a.id),
    manager.spawn('codex-worker', role, repo, fileTask('b.txt', 'B\n'), b.id),
  ]);
  const [first, second] = await Promise.all([done(wa.id), done(wb.id)]);
  assert.notEqual(first.session.threadId, second.session.threadId);
  assert.equal(fs.existsSync(path.join(repo, 'a.txt')), false); assert.equal(fs.existsSync(path.join(a.path, 'b.txt')), false);
  const ra = await manager.spawn('pi-reviewer', piRole, repo, fileTask('a.txt'), a.id);
  const rb = await manager.spawn('codex-reviewer', role, repo, fileTask('b.txt'), b.id);
  assert.equal((await done(ra.id)).text, 'A\n'); assert.equal((await done(rb.id)).text, 'B\n');
  for (const ws of [a, b]) assert.equal((await manager.workspaces.integrate(ws.id)).status, 'applied');
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'A\n'); assert.equal(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8'), 'B\n');
});

test('Codex workspace lease rejects concurrent owners, raw cwd bypass, sync and integration while active', { timeout: 30_000 }, async t => {
  const { repo, parent, launch, options, manager, done } = setup(t); const ws = await manager.workspaces.create(repo);
  const other = new AgentManager(parent, launch, options);
  const result = await Promise.allSettled([
    manager.spawn('worker', role, repo, 'HOLD', ws.id), other.spawn('reviewer', piRole, repo, 'HOLD', ws.id),
  ]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  const active = result.find(r => r.status === 'fulfilled').value;
  await assert.rejects(manager.spawn('worker', role, ws.path, 'CWD'), /workspace.*instead of cwd/i);
  await assert.rejects(manager.workspaces.integrate(ws.id), /occupied/);
  await assert.rejects(manager.send(active.id, 'CWD', 'steer', sync), /running|occupied/i);
  const contender = active.cli === 'codex' ? piRole : role;
  await assert.rejects(manager.spawn('reviewer', contender, repo, 'CWD', ws.id), /occupied/);
  await manager.send(active.id, 'FINISHED'); await done(active.id);
  assert.equal((await manager.workspaces.list())[0].occupiedBy.length, 0);
});

test('Codex keep/sync preserve original sessions, baseline notices and parent HEAD/index', { timeout: 50_000 }, async t => {
  const { repo, manager, done, requests } = setup(t); const ws = await manager.workspaces.create(repo);
  const worker = await manager.spawn('worker', role, repo, fileTask('src/base.txt', 'first\n'), ws.id); const first = await done(worker.id);
  const reviewer = await manager.spawn('reviewer', role, repo, fileTask('src/base.txt'), ws.id); const firstReview = await done(reviewer.id);
  await manager.workspaces.integrate(ws.id);
  fs.writeFileSync(path.join(repo, 'parent-new.txt'), 'parent content');
  await assert.rejects(manager.send(worker.id, 'CWD'), /baseline/i);
  await manager.send(worker.id, fileTask('src/base.txt', 'second\n'), 'steer', { baseline: 'keep' }); await done(worker.id);
  assert.equal(fs.existsSync(path.join(ws.path, 'parent-new.txt')), false);
  assert.equal((await manager.workspaces.integrate(ws.id)).status, 'applied');
  const before = { head: git(repo, 'rev-parse', 'HEAD'), refs: git(repo, 'show-ref'), index: fs.readFileSync(path.join(repo, '.git/index')).toString('base64') };
  fs.mkdirSync(path.join(ws.path, 'ignored')); fs.writeFileSync(path.join(ws.path, 'ignored/cache'), 'keep');
  await assert.rejects(manager.send(worker.id, 'CWD', 'steer', { baseline: 'sync' }), /uncommitted|authoriz/i);
  await manager.send(worker.id, fileTask('parent-new.txt'), 'steer', sync); const resumed = await done(worker.id);
  assert.equal(resumed.text, 'parent content'); assert.deepEqual(resumed.session, first.session);
  assert.equal(manager.workspaces.get(ws.id).sync.status, 'applied');
  assert.equal(fs.readFileSync(path.join(ws.path, 'ignored/cache'), 'utf8'), 'keep');
  assert.deepEqual({ head: git(repo, 'rev-parse', 'HEAD'), refs: git(repo, 'show-ref'), index: fs.readFileSync(path.join(repo, '.git/index')).toString('base64') }, before);
  await assert.rejects(manager.send(reviewer.id, 'CWD'), /baseline/i);
  await manager.send(reviewer.id, fileTask('parent-new.txt'), 'steer', { baseline: 'keep' }); const review = await done(reviewer.id);
  assert.deepEqual(review.session, firstReview.session); assert.equal(review.text, 'parent content');
  const calls = requests(); const check = calls.findIndex(r => r.method === 'thread/read');
  assert.ok(check > 0); assert.equal(calls[check].params.includeTurns, false);
  assert.equal(calls[check].params.threadId, first.session.threadId);
  assert.ok(calls.slice(check + 1).some(r => r.method === 'thread/resume' && r.params.threadId === first.session.threadId));
  for (const id of [first.session.threadId, firstReview.session.threadId]) {
    const prompt = calls.filter(r => r.method === 'turn/start' && r.params.threadId === id).at(-1).params.input[0].text;
    assert.match(prompt, /Workspace baseline/); assert.match(prompt, /parent-new.txt/);
  }
});

test('Codex missing or changed original thread fails before sync without a new run', { timeout: 45_000 }, async t => {
  const { repo, home, manager, done, requests } = setup(t); const ws = await manager.workspaces.create(repo);
  const child = await manager.spawn('worker', role, repo, 'CWD', ws.id); const first = await done(child.id);
  fs.writeFileSync(path.join(repo, 'src/base.txt'), 'parent changed\n');
  const file = path.join(home, `${first.session.threadId}.json`), saved = fs.readFileSync(file);
  const before = baseline(ws), record = manager.workspaces.get(ws.id);
  fs.renameSync(file, `${file}.retained`);
  await assert.rejects(manager.send(child.id, 'CWD', 'steer', sync), /missing.*no synchronization|no synchronization.*missing/is);
  fs.renameSync(`${file}.retained`, file);
  for (const changed of [{ id: 'other-thread' }, { sessionId: 'other-session' }, { cwd: repo }, { status: { type: 'active' } }]) {
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(saved), ...changed }));
    await assert.rejects(manager.send(child.id, 'CWD', 'steer', sync), /different|idle|status/i);
    assert.deepEqual(baseline(ws), before); assert.deepEqual(manager.workspaces.get(ws.id), record);
    assert.equal(manager.get(child.id).runCount, 1);
  }
  fs.writeFileSync(file, saved);
  assert.equal(requests().filter(r => r.method === 'thread/start').length, 1);
  assert.equal(requests().filter(r => r.method === 'turn/start').length, 1);
  const readPids = requests().filter(r => r.method === 'thread/read').map(r => r.pid);
  assert.ok(readPids.length >= 5); assert.ok(readPids.every(pid => !processAlive(pid)));
  await manager.send(child.id, fileTask('src/base.txt'), 'steer', sync);
  assert.equal((await done(child.id)).text, 'parent changed\n');
});

test('Codex preflight runs inside the workspace lock; a racing reviewer cannot enter', { timeout: 30_000 }, async t => {
  const { repo, home, parent, launch, options, manager, done, requests } = setup(t, ['--hold-read']);
  const ws = await manager.workspaces.create(repo); const child = await manager.spawn('worker', role, repo, 'CWD', ws.id); await done(child.id);
  fs.writeFileSync(path.join(repo, 'src/base.txt'), 'new baseline\n');
  const pending = manager.send(child.id, 'CWD', 'steer', sync);
  try {
    await waitUntil('native preflight read', () => requests().some(r => r.method === 'thread/read'));
    const other = new AgentManager(parent, launch, options);
    await assert.rejects(other.spawn('reviewer', piRole, repo, 'CWD', ws.id), /busy|occupied/);
    // Same-process integrations queue deliberately. Another process must instead observe the disk lock.
    const module = new URL('../dist/manager.js', import.meta.url).href;
    const code = `const {AgentManager}=await import(${JSON.stringify(module)});const m=new AgentManager(${JSON.stringify(parent)},${JSON.stringify(launch)});try{await m.workspaces.integrate(${JSON.stringify(ws.id)});console.log('unexpected integration');}catch(e){console.log(e.message)}`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { timeout: 10_000 });
    assert.match(stdout, /busy|occupied/);
  } finally { fs.writeFileSync(path.join(home, 'release-read'), ''); await pending; }
  await done(child.id);
  assert.equal(manager.list().length, 1);
});

test('Codex resume failure after successful sync retains applied baseline and original identity', { timeout: 30_000 }, async t => {
  const { repo, manager, done, requests } = setup(t, ['--reject-resume']); const ws = await manager.workspaces.create(repo);
  const child = await manager.spawn('worker', role, repo, 'CWD', ws.id); const first = await done(child.id);
  fs.writeFileSync(path.join(repo, 'src/base.txt'), 'synced content\n');
  await manager.send(child.id, 'CWD', 'steer', sync); const failed = await done(child.id, 'failed');
  assert.match(failed.error, /resume rejected/i); assert.deepEqual(failed.session, first.session); assert.equal(failed.accepted, false);
  assert.deepEqual(failed.workspaceBaseline, first.workspaceBaseline, 'the failed session has not acknowledged the new baseline');
  const synced = manager.workspaces.get(ws.id);
  assert.equal(synced.sync.status, 'applied'); assert.notEqual(synced.baseCommit, ws.baseCommit);
  assert.equal(fs.readFileSync(path.join(ws.path, 'src/base.txt'), 'utf8'), 'synced content\n');
  assert.ok(fs.existsSync(synced.sync.backupFile)); assert.ok(fs.existsSync(synced.sync.indexBackupFile));
  assert.equal(readJson(path.join(path.dirname(synced.sync.patchFile), 'workspace.before.json')).baseCommit, ws.baseCommit);
  assert.equal(requests().filter(r => r.method === 'thread/start').length, 1); assert.equal(requests().filter(r => r.method === 'turn/start').length, 1);
  await assert.rejects(manager.send(child.id, 'CWD'), /baseline/i);
});

test('Codex sync refuses unintegrated and staged data before native preflight', { timeout: 30_000 }, async t => {
  const { repo, manager, done, requests } = setup(t); const ws = await manager.workspaces.create(repo);
  const child = await manager.spawn('worker', role, repo, 'CWD', ws.id); await done(child.id);
  fs.writeFileSync(path.join(ws.path, 'unintegrated.txt'), 'retain');
  await assert.rejects(manager.send(child.id, 'CWD', 'steer', sync), /unintegrated/i);
  fs.unlinkSync(path.join(ws.path, 'unintegrated.txt'));
  fs.writeFileSync(path.join(ws.path, 'src/base.txt'), 'staged'); git(ws.path, 'add', '.'); fs.writeFileSync(path.join(ws.path, 'src/base.txt'), 'base\n');
  const before = baseline(ws);
  await assert.rejects(manager.send(child.id, 'CWD', 'steer', sync), /staged/i);
  assert.deepEqual(baseline(ws), before); assert.equal(manager.get(child.id).runCount, 1);
  assert.equal(requests().some(r => r.method === 'thread/read'), false);
});
