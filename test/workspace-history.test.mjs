import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AgentManager } from '../dist/manager.js';
import { readJson, writeJson, waitUntil } from '../dist/storage.js';
import { tempDir } from './helpers/tmp.mjs';
const pi = fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url));
const codex = fileURLToPath(new URL('./fixtures/codex.mjs', import.meta.url));
function setup(t) {
  const cwd = tempDir('workspace-history'), base = path.join(cwd, 'base'); fs.mkdirSync(base);
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=', '-C', base, ...args], { encoding: 'utf8', windowsHide: true });
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@invalid'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(base, 'input.txt'), 'committed\n'); git('add', '.'); git('commit', '-qm', 'baseline');
  const head = git('rev-parse', 'HEAD'), refs = git('show-ref'), index = fs.readFileSync(path.join(base, '.git', 'index'));
  const home = path.join(cwd, 'home'); fs.mkdirSync(home); fs.writeFileSync(path.join(home, 'fixture-home'), '');
  const codexLaunch = { command: process.execPath, args: [codex] };
  const m = new AgentManager(path.join(cwd, 'parent.jsonl'), { command: process.execPath, args: [pi] }, { launch: codexLaunch, home });
  const release = (id, phase = 'completed') => waitUntil('workspace history owner release', () => {
    const s = m.get(id); return s.phase === phase && !fs.existsSync(path.join(m.root, id, 'owner.lock')) ? s : undefined;
  }, 12000);
  t.after(async () => {
    for (const s of m.list()) if (s.runId && fs.existsSync(path.join(m.root, s.id, 'owner.lock'))) await m.close(s.id);
    assert.equal(git('rev-parse', 'HEAD'), head); assert.equal(git('show-ref'), refs);
    assert.deepEqual(fs.readFileSync(path.join(base, '.git', 'index')), index);
  });
  const prune = hash => {
    git('reflog', 'expire', '--expire=now', '--all'); git('prune', '--expire=now');
    assert.equal(git('cat-file', '--batch-check'), '');
    assert.throws(() => git('cat-file', '-e', hash), /failed/);
  };
  return { cwd, base, m, git, release, prune, codexLaunch };
}
const role = { description: 'test', instructions: 'test' };
const reason = { reason: 'Authorized disposable test baseline' };
const request = (m, s) => readJson(path.join(m.root, s.id, 'runs', s.runId, 'request.json')).message;

test('old reviewer keeps its native memory after multiple syncs and pruning its acknowledged baseline', { timeout: 30000 }, async t => {
  const { base, m, release, prune } = setup(t);
  fs.writeFileSync(path.join(base, 'input.txt'), 'dirty A\n'); const ws = await m.workspaces.create(base, { includeUncommitted: reason });
  const reviewer = await m.spawn('reviewer', role, base, 'REMEMBER reviewer-token', ws.id); await release(reviewer.id);
  const worker = await m.spawn('worker', role, base, 'REMEMBER worker-token', ws.id); await release(worker.id);
  for (const content of ['dirty B\n', 'dirty C\n']) {
    fs.writeFileSync(path.join(base, 'input.txt'), content);
    await m.send(worker.id, 'RECALL', 'steer', { baseline: 'sync', includeUncommitted: reason }); await release(worker.id);
  }
  prune(ws.baseCommit);
  await assert.rejects(m.send(reviewer.id, 'RECALL'), /baseline|keep|sync/i);
  await m.send(reviewer.id, 'RECALL', 'steer', { baseline: 'keep' }); const next = await release(reviewer.id);
  assert.equal(next.text, 'reviewer-token'); assert.equal(next.sessionId, reviewer.sessionId);
  assert.equal(fs.readFileSync(path.join(ws.path, 'input.txt'), 'utf8'), 'dirty C\n');
  const prompt = request(m, next); assert.match(prompt, /baseline.*unavailable/i); assert.match(prompt, /all assigned files/i);
  assert.match(prompt, /input.txt/); assert(!prompt.includes('no Git content changes'));
  assert.equal(next.workspaceBaseline.commit, m.workspaces.get(ws.id).baseCommit);
});

test('sync-applied resume failure retains the old acknowledgement, then keep survives its pruning', { timeout: 30000 }, async t => {
  const { base, m, release, prune, codexLaunch } = setup(t);
  fs.writeFileSync(path.join(base, 'input.txt'), 'dirty A\n'); const ws = await m.workspaces.create(base, { includeUncommitted: reason });
  const worker = await m.spawn('worker', { ...role, cli: 'codex', model: 'fixture' }, base, 'REMEMBER original-token', ws.id); await release(worker.id);
  const file = path.join(m.root, worker.id, 'spec.json'), original = readJson(file);
  writeJson(file, { ...original, launch: { ...codexLaunch, args: [...codexLaunch.args, '--reject-resume'] } });
  fs.writeFileSync(path.join(base, 'input.txt'), 'dirty B\n');
  await m.send(worker.id, 'RECALL', 'steer', { baseline: 'sync', includeUncommitted: reason }); const failed = await release(worker.id, 'failed');
  assert.equal(failed.accepted, false); assert.deepEqual(failed.session, worker.session);
  assert.deepEqual(readJson(file).workspaceBaseline, original.workspaceBaseline); assert.equal(m.workspaces.get(ws.id).sync.status, 'applied');
  prune(ws.baseCommit); writeJson(file, { ...readJson(file), launch: codexLaunch });
  await m.send(worker.id, 'RECALL', 'steer', { baseline: 'keep' }); const next = await release(worker.id);
  assert.equal(next.text, 'original-token'); assert.deepEqual(next.session, worker.session); assert.match(request(m, next), /all assigned files/i);
  assert.equal(fs.readFileSync(path.join(ws.path, 'input.txt'), 'utf8'), 'dirty B\n');
});
