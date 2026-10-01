import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentManager } from '../dist/manager.js';
import { CodexAdapter } from '../dist/codex-adapter.js';
import { waitUntil, processAlive } from '../dist/storage.js';
const codex = fileURLToPath(new URL('./fixtures/codex.mjs', import.meta.url));
const pi = fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url));
fs.mkdirSync('.test-output', { recursive: true });
function setup(flags = []) {
  const cwd = fs.mkdtempSync(path.resolve('.test-output/shutdown-')), home = path.join(cwd, 'home');
  fs.mkdirSync(home); fs.writeFileSync(path.join(home, 'fixture-home'), '');
  const role = { cli: 'codex', model: 'fixture', description: 'test', instructions: 'test' };
  const launch = { command: process.execPath, args: [codex, ...flags] };
  const m = new AgentManager(path.join(cwd, 'parent.jsonl'), { command: process.execPath, args: [pi] }, { launch, home });
  return { cwd, home, role, launch, m };
}

test('multiple approvals without cancellation receipts do not delay worker interruption', { timeout: 80000 }, async () => {
  const { cwd, home, role, m } = setup(['--no-resolved']);
  const first = await m.spawn('worker', role, cwd, 'APPROVAL DOUBLE'); assert.equal(first.questions.length, 2);
  try {
    const start = Date.now(), closed = await m.close(first.id);
    assert(Date.now() - start < 8000, 'cancellation receipts must not multiply the stop deadline');
    assert.equal(closed.phase, 'stopped'); assert.deepEqual(closed.session, first.session);
    assert.equal(closed.questions.length, 0);
    const requests = fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(requests.filter(r => r.result?.decision === 'cancel').length, 2);
    assert.equal(requests.filter(r => r.method === 'turn/interrupt').length, 1);
    assert(!requests.some(r => r.result?.decision === 'accept'));
    const audit = fs.readFileSync(path.join(m.root, first.id, 'runs', first.runId, 'permissions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(audit.length, 2); assert(audit.every(r => r.decision === 'cancelled' && r.actor === 'controller'));
  } finally {
    await waitUntil('stop probe original worker release', () => !processAlive(first.workerPid), 70000);
    assert(!fs.existsSync(path.join(m.root, first.id, 'owner.lock')));
  }
});

test('shutdown audit failure still interrupts without approving or retrying a decision', { timeout: 15000 }, async () => {
  const { cwd, home, role, m } = setup(['--no-resolved']);
  const first = await m.spawn('worker', role, cwd, 'APPROVAL DOUBLE');
  fs.mkdirSync(path.join(m.root, first.id, 'runs', first.runId, 'permissions.jsonl'));
  try {
    const start = Date.now(), closed = await m.close(first.id);
    assert(Date.now() - start < 8000); assert.equal(closed.phase, 'stopped');
    const requests = fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert(!requests.some(r => r.result?.decision), 'failed intent logging must not send an action decision');
    assert.equal(requests.filter(r => r.method === 'turn/interrupt').length, 1);
  } finally { await waitUntil('original worker release after audit failure', () => !processAlive(first.workerPid), 10000); }
});

test('Codex missing interrupt acknowledgement shares one five-second stop budget', { timeout: 45000 }, async () => {
  const { cwd, home, role, launch } = setup(['--ignore-interrupt']);
  const c = new CodexAdapter({ spec: { cwd, codexHome: home, roleName: 'worker', role, launch },
    logFile: path.join(cwd, 'events.jsonl'), onEvent: () => {}, requestTimeout: 30000 });
  await c.ready(); await c.start('HOLD');
  try {
    const start = Date.now(), result = await c.stop();
    // Allow Windows tree-cleanup latency without allowing the 30s RPC deadline
    // to replace the product's 5s stop deadline. Removing that deadline must fail.
    assert(Date.now() - start < 12000); assert.equal(result.forced, true);
  } finally { await c.end(); }
});
