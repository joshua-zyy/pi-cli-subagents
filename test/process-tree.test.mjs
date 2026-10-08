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

const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(t, platform = 'win32') {
  const cwd = tempDir('process-tree');
  const children = [], killers = [], errors = [];
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
    spawnMock.mock.restore(); errorMock.mock.restore(); syncBuiltinESMExports();
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
  return {make, killers, errors, close, tick:async () => {t.mock.timers.tick(5000); await flush();}};
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
