// Readers and assertion helpers for the read-only real-acceptance auditor. This module holds no
// top-level await and no CLI entry point, so a case module can import it freely; the entry point
// is audit.mjs.
//
// It reads the parent session, the extension's own records, native logs and the filesystem. It
// starts no model, CLI or RPC, executes no case command and rewrites nothing.
//
// Evidence splits in two. Immutable evidence (the parent session, the extension's own records,
// native logs, Claude/Codex transcripts) is asserted directly. Mutable artifacts (effect files,
// child working directories, worktrees, Git state) can be cleaned up or changed after the round;
// those checks run through ev.effects, which reports "unavailable" instead of passing or failing
// when the artifact is gone. A round therefore reports what was checked and what could not be.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

export const exists = file => fs.existsSync(file);
export const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export const lines = file => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
export const jsonl = file => (exists(file) ? lines(file).map(line => { try { return JSON.parse(line); } catch { return {}; } }) : []);
export const text = file => (exists(file) ? fs.readFileSync(file, 'utf8') : '');
export const blocks = row => (Array.isArray(row.message?.content) ? row.message.content : []);
export const textOf = row => blocks(row).filter(block => block.type === 'text').map(block => block.text).join('\n');
/** True while a pid is alive; an unknown error is treated as alive (never as proof of release). */
export const live = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
export const git = (repo, command) => { try { return execSync(`git -C "${repo}" ${command}`, { encoding: 'utf8' }).trim(); } catch (error) { return `ERR: ${String(error.message).slice(0, 160)}`; } };

/** Assert a non-decreasing timeline of [label, milliseconds] pairs. */
export function ascending(entries) {
  for (let index = 1; index < entries.length; index += 1) {
    const [previousLabel, previous] = entries[index - 1], [label, value] = entries[index];
    assert.ok(Number.isFinite(previous) && Number.isFinite(value), `${label}: timestamp missing (${previousLabel}=${previous} -> ${label}=${value})`);
    assert.ok(previous <= value, `${label} (${value}) must not precede ${previousLabel} (${previous})`);
  }
}

/** Mutable-artifact checks. A missing artifact becomes "unavailable", never a pass. */
function createEffects() {
  const unavailable = [];
  const skip = target => { unavailable.push(target); return 'unavailable'; };
  return {
    unavailable,
    checked: 0,
    /** Run a check that needs a mutable artifact; report unavailable when it is gone. */
    guard(label, required, run) { if (!exists(required)) return skip(`${label} (${required})`); run(); this.checked += 1; return 'checked'; },
    mtime(file) { if (!exists(file)) { skip(file); return undefined; } this.checked += 1; return Math.round(fs.statSync(file).mtimeMs); },
    emptyDir(dir) { if (!exists(dir)) return skip(dir); assert.deepEqual(fs.readdirSync(dir), [], `${dir} must still be empty`); this.checked += 1; return 'checked'; },
    dirEquals(dir, names) { if (!exists(dir)) return skip(dir); assert.deepEqual(fs.readdirSync(dir).sort(), [...names].sort(), `${dir} listing`); this.checked += 1; return 'checked'; },
    absent(file) { if (!exists(file)) { this.checked += 1; return 'checked'; } assert.fail(`${file} must not exist`); },
    equals(file, expected, options = {}) {
      if (!exists(file)) return skip(file);
      assert.equal(fs.readFileSync(file, options.encoding ?? 'utf8'), expected, `${file} content`);
      if (options.size !== undefined) assert.equal(fs.statSync(file).size, options.size, `${file} size`);
      this.checked += 1;
      return 'checked';
    },
  };
}

function loadAgent(dir) {
  const spec = read(path.join(dir, 'spec.json'));
  const state = read(path.join(dir, 'state.json'));
  const runsDir = path.join(dir, 'runs'), reportDir = path.join(dir, 'reports');
  const runIds = exists(runsDir) ? fs.readdirSync(runsDir).sort() : [];
  const reports = exists(reportDir) ? fs.readdirSync(reportDir).sort() : [];
  return {
    dir, spec, state, runIds, reports,
    run: runId => {
      const runDir = path.join(runsDir, runId);
      return {
        runId, dir: runDir,
        request: read(path.join(runDir, 'request.json')),
        permissions: jsonl(path.join(runDir, 'permissions.jsonl')),
        permissionsPresent: exists(path.join(runDir, 'permissions.jsonl')),
        stderr: text(path.join(runDir, 'events.jsonl.stderr')),
        eventFile: path.join(runDir, 'events.jsonl'),
        workerLogBytes: exists(path.join(runDir, 'worker.log')) ? fs.statSync(path.join(runDir, 'worker.log')).size : 0,
      };
    },
    result: runId => read(path.join(reportDir, `${runId}-result.json`)),
    waiting: runId => { const file = reports.find(name => name.startsWith(`${runId}-waiting-`)); return file && read(path.join(reportDir, file)); },
    waitingFiles: runId => reports.filter(name => name.startsWith(`${runId}-waiting-`)),
    events: () => jsonl(state.logFile),
    /** Final resource state. A replayed round has already been released, so this is terminal. */
    release: () => ({ ownerLock: exists(path.join(dir, 'owner.lock')), endpoint: exists(path.join(dir, 'endpoint.json')), runtimeClosed: state.runtimeClosed ?? null, workerPid: state.workerPid, workerLive: live(state.workerPid), cliPid: state.cliPid, cliLive: live(state.cliPid) }),
  };
}

export function loadEvidence(sessionFile) {
  const rows = jsonl(sessionFile);
  const agentsDir = `${sessionFile}.subagents`;
  const agentIds = exists(agentsDir) ? fs.readdirSync(agentsDir).filter(name => name !== 'workspaces') : [];
  const calls = rows.flatMap(row => blocks(row).filter(block => block.type === 'toolCall').map(block => ({ ...block, ts: row.timestamp })));
  const notices = rows.map((row, index) => ({ ...row, line: index + 1 })).filter(row => row.type === 'custom_message' && row.customType === 'cli-subagents-report');
  const list = (name, action) => calls.filter(call => call.name === name && (action === undefined || call.arguments.action === action));
  return {
    sessionFile, agentsDir, rows, calls, notices, agentIds,
    agents: new Map(agentIds.map(id => [id, loadAgent(path.join(agentsDir, id))])),
    effects: createEffects(),
    users: rows.filter(row => row.message?.role === 'user'),
    toolResults: rows.filter(row => row.message?.role === 'toolResult').map(textOf),
    humanActionMessages: rows.filter(row => row.type === 'custom_message' && row.customType !== 'cli-subagents-report'),
    list,
    one(name, action) { const found = list(name, action); assert.equal(found.length, 1, `expected exactly one ${name}/${action ?? ''} call, found ${found.length}`); return found[0]; },
    /** The single agent record, asserted; multi-agent rounds index agentIds directly. */
    only() { assert.equal(agentIds.length, 1, `expected one agent record, found ${agentIds.length}: ${agentIds.join(', ')}`); return this.agents.get(agentIds[0]); },
    workspace: id => read(path.join(agentsDir, 'workspaces', id, 'workspace.json')),
    notice: id => notices.find(entry => entry.details?.ids?.includes(id)),
    /** Notice whose recorded id starts with a prefix, e.g. a run's waiting id. */
    noticeStartingWith: prefix => notices.find(entry => entry.details?.ids?.some(id => String(id).startsWith(prefix))),
    /** 1-based line of the first row carrying a matching tool call; 0 when absent. */
    lineOfCall: (name, action) => rows.findIndex(row => blocks(row).some(block => block.type === 'toolCall' && block.name === name && (action === undefined || block.arguments.action === action))) + 1,
    ascending, git, live, assert, blocks, textOf, jsonl, read, text, exists,
  };
}
