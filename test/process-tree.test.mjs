// Real adapter end() paths, controlled child-process events; no CLI/model is launched.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { PiProcess } from '../dist/pi-process.js';
import { CodexAdapter } from '../dist/codex-adapter.js';
import { ClaudeAdapter } from '../dist/claude-adapter.js';
import { tempDir } from './helpers/tmp.mjs';
import { killProcessTree } from '../dist/process-tree.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const row = (pid, ppid, group = pid, start = 'Thu Oct 22 07:00:00 2026') => `${pid} ${ppid} ${group} ${start}`;
function harness(t, platform = 'win32') {
  const cwd = tempDir('process-tree');
  const children = [], killers = [], errors = [], processTables = [], processReads = [];
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {...descriptor, value:platform});
  t.mock.timers.enable({apis:['setTimeout']});
  const errorMock = t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  const spawnMock = t.mock.method(cp, 'spawn', (command, args) => {
    if (command === 'taskkill.exe') {
      const killer = new EventEmitter(); killers.push({killer, args}); return killer;
    }
    assert.equal(command, 'fixture-cli', 'tests must not start a real executable');
    const child = Object.assign(new EventEmitter(), {
      pid:10000 + children.length, exitCode:null, signalCode:null,
      stdin:new PassThrough(), stdout:new PassThrough(), stderr:new PassThrough(),
      signals:[], killAccepted:true,
      kill(signal) { this.signals.push(signal); return this.killAccepted; },
    });
    children.push(child); return child;
  });
  const execMock = t.mock.method(cp, 'execFile', (command, args, options, callback) => {
    assert.equal(platform, 'linux', 'Windows cleanup must never query ps');
    assert.equal(command, 'ps'); assert.equal(options.shell, false);
    assert.ok(options.timeout > 0 && options.timeout <= 1000);
    processReads.push(args);
    let result = processTables.length ? processTables.shift() : children.map(child => row(child.pid, process.pid)).join('\n');
    if (typeof result === 'function') result = result();
    if (result instanceof Error) callback(result, '', ''); else callback(null, result, '');
    return new EventEmitter();
  });
  syncBuiltinESMExports();
  const close = child => {
    if (child.signalCode !== null) return;
    child.signalCode = 'SIGKILL'; child.stdin.destroy(); child.stdout.end(); child.stderr.end();
    child.emit('close', null, 'SIGKILL');
  };
  t.after(async () => {
    for (const child of children) close(child);
    for (const {killer} of killers) killer.emit('close', 1);
    await flush();
    spawnMock.mock.restore(); execMock.mock.restore(); errorMock.mock.restore(); syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', descriptor); t.mock.timers.reset();
  });
  const make = cli => {
    const launch = {command:'fixture-cli',args:[]}, logFile = path.join(cwd, `${cli}-${children.length}.jsonl`);
    const role = {cli,model:'fixture',description:'fixture',instructions:'fixture'};
    const adapter = cli === 'pi' ? new PiProcess(launch, [], cwd, logFile, () => {})
      : new (cli === 'codex' ? CodexAdapter : ClaudeAdapter)({
        spec:{cwd,role,roleName:'fixture',launch,codexHome:cwd,claudeHome:cwd},logFile,onEvent(){},
      });
    return {adapter, child:children.at(-1)};
  };
  return {make, killers, errors, close, processTables, processReads, tick:async () => {t.mock.timers.tick(5000); await flush();}};
}

test('Windows tree termination failures stay unconfirmed, are diagnosed and do not suppress a later attempt', async t => {
  const h = harness(t);
  for (const cli of ['pi','codex','claude']) for (const failure of ['nonzero','spawn-error']) {
    const {adapter,child} = h.make(cli), before = h.killers.length, diagnostics = h.errors.length;
    let ended = false;
    const first = adapter.end().then(result => {ended = true; return result;});
    await h.tick();
    assert.equal(h.killers.length, before + 1);
    if (failure === 'nonzero') h.killers.at(-1).killer.emit('close', 1);
    else h.killers.at(-1).killer.emit('error', new Error('taskkill unavailable'));
    await flush();
    assert.equal(ended, false, 'a failed termination command is not a child exit');
    assert.deepEqual(child.signals, [], 'a root-only kill is not a safe Windows tree-termination fallback');
    assert.ok(h.errors.length > diagnostics, 'the failure must remain visible in diagnostics');
    const retry = adapter.end(); await h.tick();
    assert.equal(h.killers.length, before + 2, 'a failed attempt must not permanently disable later cleanup');
    assert.deepEqual(h.killers.at(-1).args, ['/PID',String(child.pid),'/T','/F']);
    h.killers.at(-1).killer.emit('close', 0); await flush();
    assert.equal(ended, false, 'even taskkill exit 0 does not replace the actual child close event');
    h.close(child);
    for (const result of await Promise.all([first,retry])) {assert.equal(result.forced,true);assert.equal(result.exit.signal,'SIGKILL');}
  }
});

test('concurrent end deadlines share one in-flight termination command for each adapter', async t => {
  const h = harness(t);
  for (const cli of ['pi','codex','claude']) {
    const {adapter,child} = h.make(cli), before = h.killers.length;
    const first = adapter.end(), second = adapter.end(); await h.tick();
    assert.equal(h.killers.length, before + 1);
    h.killers.at(-1).killer.emit('close', 0); await flush();
    assert.deepEqual(child.signals, []);
    h.close(child); await Promise.all([first,second]);
  }
  assert.deepEqual(h.errors, []);
});

// end() reads its owner's forced marker when `closed` resolves, and the child can close while the
// termination command it started is still in flight. The marker is then the only evidence that this
// shutdown forced the process tree, so it has to be set before the command is awaited, not after.
test('a forced shutdown is recorded before the termination command it started is awaited', async t => {
  const h = harness(t);
  for (const cli of ['pi','codex','claude']) {
    const {adapter,child} = h.make(cli), before = h.killers.length;
    const ending = adapter.end();
    await h.tick();
    assert.equal(h.killers.length, before + 1, `${cli}: the end deadline starts one termination`);
    h.close(child);
    assert.equal((await ending).forced, true, `${cli}: end() must observe the forced shutdown`);
    h.killers.at(-1).killer.emit('close', 0);
  }
  assert.deepEqual(h.errors, []);
});

test('POSIX process-group termination and its existing direct-child fallback remain available', async t => {
  const h = harness(t, 'linux'), groups = [];
  let groupFails = false;
  t.mock.method(process, 'kill', (pid, signal) => {groups.push([pid,signal]);if(groupFails)throw Error('missing group');return true;});
  for (const cli of ['pi','codex','claude']) for (const fallback of [false,true]) {
    groupFails = fallback;
    const {adapter,child} = h.make(cli), ending = adapter.end(); await h.tick();
    assert.deepEqual(groups.at(-1), [-child.pid,'SIGKILL']);
    assert.deepEqual(child.signals, fallback ? ['SIGKILL'] : []);
    h.close(child); assert.equal((await ending).forced,true);
  }
  assert.equal(h.killers.length, 0); assert.deepEqual(h.errors, []);
});

test('POSIX cleanup kills only captured escaped descendants, deepest first, before the original group', async t => {
  const h = harness(t, 'linux'), { child } = h.make('pi'), calls = [];
  const root = child.pid;
  const table = [row(root, process.pid), row(root + 1, root, root), row(root + 2, root + 1), row(root + 3, root + 2, root + 2), row(20000, process.pid)].join('\n');
  h.processTables.push(table, table, table);
  t.mock.method(process, 'kill', (pid, signal) => { calls.push([pid, signal]); return true; });
  await killProcessTree(child);
  assert.deepEqual(calls, [[root + 3, 'SIGKILL'], [root + 2, 'SIGKILL'], [-root, 'SIGKILL']]);
  assert.equal(h.processReads.length, 3, 'snapshot plus identity recheck for each escaped descendant');
  assert.deepEqual(h.errors, []);
});

test('POSIX changed root or descendant identity refuses broader termination and does not poison a later attempt', async t => {
  const h = harness(t, 'linux'), calls = [];
  t.mock.method(process, 'kill', (pid, signal) => { calls.push([pid, signal]); return true; });
  for (const changed of ['start', 'parent', 'group', 'root']) {
    const { child } = h.make('pi'), root = child.pid, leaf = root + 100;
    const table = [row(root, process.pid), row(leaf, root)].join('\n');
    const altered = row(root, process.pid, root, changed === 'root' ? 'Thu Oct 22 07:00:01 2026' : undefined) + '\n' + row(leaf, changed === 'parent' ? 1 : root, changed === 'group' ? leaf + 1 : leaf, changed === 'start' ? 'Thu Oct 22 07:00:01 2026' : undefined);
    h.processTables.push(table, altered);
    const before = calls.length, errors = h.errors.length;
    await killProcessTree(child);
    assert.equal(calls.length, before, 'do not signal a changed PID or hide failure by killing the root');
    assert.deepEqual(child.signals, []);
    assert.equal(h.errors.length, errors + 1);
    assert.match(h.errors.at(-1), /identity|changed/i);
    h.processTables.push(table, table);
    await killProcessTree(child);
    assert.deepEqual(calls.slice(before), [[leaf, 'SIGKILL'], [-root, 'SIGKILL']]);
  }
});

test('POSIX snapshot errors and invalid root ownership stay unconfirmed without a root-only fallback', async t => {
  const h = harness(t, 'linux'), calls = [];
  t.mock.method(process, 'kill', pid => { calls.push(pid); return true; });
  for (const failure of [Object.assign(Error('ps unavailable'), { code: 'ENOENT' }), Object.assign(Error('ps timed out'), { code: 'ETIMEDOUT' }), 'bad process row', '']) {
    const { child } = h.make('pi'), errors = h.errors.length;
    h.processTables.push(failure);
    await killProcessTree(child);
    assert.deepEqual(calls, []); assert.deepEqual(child.signals, []);
    assert.equal(h.errors.length, errors + 1);
  }
  const { child } = h.make('pi'); h.processTables.push(row(child.pid, 1));
  await killProcessTree(child);
  assert.deepEqual(calls, []); assert.deepEqual(child.signals, []);
  assert.match(h.errors.at(-1), /ownership|owner/i);
});

test('POSIX observed root exit during enumeration never targets a reused root or its old descendants', async t => {
  const h = harness(t, 'linux'), calls = [];
  t.mock.method(process, 'kill', pid => { calls.push(pid); return true; });
  for (const phase of ['capture', 'recheck']) {
    const { child } = h.make('pi');
    const table = row(child.pid, process.pid) + '\n' + row(child.pid + 100, child.pid);
    if (phase === 'recheck') h.processTables.push(table);
    h.processTables.push(() => { h.close(child); return table; });
    await killProcessTree(child);
    assert.deepEqual(calls, []); assert.deepEqual(child.signals, []); assert.deepEqual(h.errors, []);
  }
});

test('POSIX a child that is not its group leader never targets a different numeric process group', async t => {
  const h = harness(t, 'linux'), { child } = h.make('pi'), calls = [];
  h.processTables.push(row(child.pid, process.pid, process.pid));
  t.mock.method(process, 'kill', pid => { calls.push(pid); return true; });
  await killProcessTree(child);
  assert.deepEqual(calls, []); assert.deepEqual(child.signals, ['SIGKILL']); assert.deepEqual(h.errors, []);
});

test('POSIX escaped-descendant disappearance is benign but signal denial must not kill the root', async t => {
  const h = harness(t, 'linux');
  for (const code of ['ESRCH', 'EPERM', 'missing']) {
    const { child } = h.make('pi'), root = child.pid, leaf = root + 100, calls = [], errors = h.errors.length;
    const table = row(root, process.pid) + '\n' + row(leaf, root);
    h.processTables.push(table, code === 'missing' ? row(root, process.pid) : table);
    const kill = t.mock.method(process, 'kill', pid => { calls.push(pid); if (pid === leaf) throw Object.assign(Error(code), { code }); return true; });
    await killProcessTree(child);
    assert.deepEqual(calls, code === 'ESRCH' ? [leaf, -root] : code === 'missing' ? [-root] : [leaf]);
    assert.equal(h.errors.length, errors + (code === 'EPERM' ? 1 : 0));
    assert.deepEqual(child.signals, []); kill.mock.restore();
  }
});
