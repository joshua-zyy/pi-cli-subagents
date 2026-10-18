import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, statSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { control } from "./control.js";
import { readActivity } from "./activity.js";
import { codexHome, codexLaunch } from "./codex-launch.js";
import { CodexAdapter } from "./codex-adapter.js";
import { inspectPiSession } from "./pi-adapter.js";
import { claudeLaunch } from "./claude-launch.js";
import { inspectClaudeSession } from "./claude-adapter.js";
import { nativeSession } from "./cli-adapter.js";
import { validateRoleFile } from "./roles.js";
import { WorkspaceDecisionRequired, WorkspaceStore, type ResumeOptions } from "./workspace.js";
import { directories, jsonFiles, processAbsent, processAlive, readJson, shorten, waitUntil, writeJson, writeJsonExclusive } from "./storage.js";
import type { AgentSpec, AgentState, AgentView, Control, ControlResult, Delivery, Endpoint, Launch, NativeSession, OperationReceipt, ReclaimRecord, Report, Role, SessionHandle, StartRequest, TaskRun } from "./types.js";

const workerFile = fileURLToPath(new URL("./worker.js", import.meta.url));

/**
 * Runtimes this process is admitting right now, keyed by an opaque token so two attempts on one
 * instance never share a slot. The authoritative count stays on disk; this covers the window where
 * a reserved run is not visible yet, and it keeps covering an uncertain attempt: a lost response
 * does not prove the run failed to start.
 */
const admitting = new Map<string, Reservation>();
let nextReservation = 0;

/** One in-flight admission: the run it reserves, and the run the instance showed beforehand. */
export interface Reservation { id: string; priorRunId?: string; newRuntime: boolean }

/** Steps that still execute: `stopping` is set before the CLI is asked to stop (worker.ts:95-107). */
const ACTIVE_PHASES = new Set(["starting", "running", "waiting", "stopping"]);
/** Unknown ownership may still execute, so it must not be mistaken for a free turn slot. */
export function countsAsActive(view: Pick<AgentView, "phase" | "reclaimed">): boolean {
  if (view.reclaimed) return false;
  return ACTIVE_PHASES.has(view.phase) || view.phase === "unreachable";
}

/** Concurrency caps for one parent session; `undefined` means that dimension is unlimited. */
export interface AdmissionCaps { active?: number; resident?: number }
const DEFAULT_ACTIVE = 4;
const DEFAULT_RESIDENT = 12;

/** Absent = not configured, `0` = unlimited, anything else must be a non-negative integer. */
function readCap(name: string, env: NodeJS.ProcessEnv): number | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  // An empty value must not read as `0` (unlimited): only an explicit `0` disables a cap.
  const text = raw.trim(), value = Number(text);
  if (!text || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer (0 disables that cap); got ${JSON.stringify(raw)}. Refusing to dispatch so the limit is not silently ignored.`);
  return value === 0 ? undefined : value;
}

/**
 * The two caps, resolved from the environment on every call so a test or a user can change them mid-run.
 * `PI_CLI_SUBAGENTS_MAX_RUNTIMES` keeps meaning the resident cap; naming both resident variables at
 * once is refused rather than resolved by an undocumented precedence.
 */
export function resolveCaps(env: NodeJS.ProcessEnv = process.env): AdmissionCaps {
  const has = (name: string) => env[name] !== undefined;
  if (has("PI_CLI_SUBAGENTS_MAX_RESIDENT") && has("PI_CLI_SUBAGENTS_MAX_RUNTIMES"))
    throw new Error("PI_CLI_SUBAGENTS_MAX_RESIDENT and PI_CLI_SUBAGENTS_MAX_RUNTIMES both set the resident cap; configure only one so the effective limit is not ambiguous.");
  const active = readCap("PI_CLI_SUBAGENTS_MAX_ACTIVE", env);
  const resident = readCap("PI_CLI_SUBAGENTS_MAX_RESIDENT", env);
  const legacy = readCap("PI_CLI_SUBAGENTS_MAX_RUNTIMES", env);
  return {
    active: has("PI_CLI_SUBAGENTS_MAX_ACTIVE") ? active : DEFAULT_ACTIVE,
    resident: has("PI_CLI_SUBAGENTS_MAX_RESIDENT") ? resident : has("PI_CLI_SUBAGENTS_MAX_RUNTIMES") ? legacy : DEFAULT_RESIDENT,
  };
}

/**
 * A managed runtime keeps its admission slot until its release is confirmed: an idle child still owns
 * its runtime (whether that keeps a resident process depends on the backend), a stopping one may still
 * be winding down, and an unknown record may still own one.
 */
export function occupiesRuntime(view: Pick<AgentView, "phase" | "runtimeClosed" | "reclaimed">): boolean {
  // A reclaim frees accounting for one runtime only; it proves neither result nor native release.
  if (view.reclaimed) return false;
  return !(view.phase === "closed" && view.runtimeClosed === true);
}

/**
 * Drop the reservations the disk can already account for, and report how many still count in each
 * dimension. A new instance is accounted once it exists; a reused one only once a run it did not have
 * is visible, because an idle instance is always visible and would otherwise release its reservation
 * immediately. Only a reservation that creates a runtime holds a resident slot.
 */
export function pruneVisibleReservations(reservations: Map<string, Reservation>, prefix: string, views: Iterable<Pick<AgentView, "id" | "runId">>): { active: number; resident: number } {
  const runById = new Map([...views].map((view) => [view.id, view.runId]));
  let active = 0, resident = 0;
  for (const [token, reservation] of [...reservations]) {
    if (!token.startsWith(prefix)) continue;
    if (runById.has(reservation.id) && runById.get(reservation.id) !== reservation.priorRunId) { reservations.delete(token); continue; }
    active++;
    if (reservation.newRuntime) resident++;
  }
  return { active, resident };
}

/** `absent` only on an explicit ESRCH answer; anything else is unknown and may not free a slot. */
function liveness(pid: number | undefined): "alive" | "absent" | "unknown" {
  if (!Number.isInteger(pid) || !pid || pid <= 0) return "unknown";
  // A failed query is unknown, never absent, and must not escape as a raw OS error.
  try { if (processAlive(pid)) return "alive"; } catch { return "unknown"; }
  return processAbsent(pid) ? "absent" : "unknown";
}

const idPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
/** Enough recent assignments to choose a reusable instance without pasting a whole work history. */
const HISTORY_LIMIT = 5;
/** Serialized UTF-16 payload + keys, not process RSS; the entry cap also bounds object overhead. */
const HISTORY_CACHE_BYTES = 4 * 1024 * 1024;
const HISTORY_CACHE_ENTRIES = 1024;

/** One-line assignment summary: the parent matches an instance to its work, not to a transcript. */
function summarize(message: string | undefined, limit = 200): string | undefined {
  const flat = typeof message === "string" ? message.replace(/\s+/g, " ").trim().slice(0, limit) : "";
  return flat || undefined;
}

export class AgentManager {
  readonly root: string;
  readonly parentFile: string;
  readonly workspaces: WorkspaceStore;
  private historyCache = new Map<string, { version: string; json: string; bytes: number }>();
  private historyCacheBytes = 0;
  constructor(parentFile: string, private readonly launch: Launch, private readonly codex?: { launch: Launch; home: string }, private readonly claude?: { launch: Launch; home: string }) {
    this.parentFile = path.resolve(parentFile);
    this.root = `${this.parentFile}.subagents`;
    this.workspaces = new WorkspaceStore(this.parentFile);
  }

  private directory(id: string): string {
    if (!idPattern.test(id)) throw new Error("Invalid agent id");
    return path.join(this.root, id);
  }
  private spec(id: string): AgentSpec {
    const spec = readJson<AgentSpec>(path.join(this.directory(id), "spec.json"));
    if (!spec || ![1, 2, 3].includes(spec.version) || (spec.version === 1 && spec.cli !== undefined && spec.cli !== "pi") || (spec.version === 2 && (spec.cli !== "codex" || !spec.codexHome)) || (spec.version === 3 && (spec.cli !== "claude" || !spec.claudeHome)) || spec.parentFile !== this.parentFile || spec.id !== id) throw new Error("This subagent does not belong to the current parent session, or its record is missing");
    return spec;
  }
  /** Cache bounded serialized summaries, never live state, ownership or endpoints. */
  private readHistory<T>(file: string, load: (mtimeMs: number) => T | undefined): T | undefined {
    const cached = this.historyCache.get(file);
    try {
      const stat = statSync(file, { bigint: true });
      const version = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      if (cached?.version === version) return JSON.parse(cached.json) as T;
      if (cached && this.historyCache.delete(file)) this.historyCacheBytes -= cached.bytes;
      const value = load(Number(stat.mtimeNs) / 1e6);
      if (value !== undefined) {
        // Materialize summaries: a clipped string must not keep a huge original backing store.
        const json = JSON.stringify(value), bytes = 2 * (json.length + file.length + version.length);
        // Full scans defeat LRU; bypass overflow rather than evicting every hit on the next poll.
        if (this.historyCache.size < HISTORY_CACHE_ENTRIES && this.historyCacheBytes + bytes <= HISTORY_CACHE_BYTES) {
          this.historyCache.set(file, { version, json, bytes }); this.historyCacheBytes += bytes;
        }
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (cached && this.historyCache.delete(file)) this.historyCacheBytes -= cached.bytes;
      return undefined;
    }
  }
  private report(file: string): (Report & { truncated: boolean }) | undefined {
    return this.readHistory(file, () => {
      const report = readJson<Report>(file);
      // Waiting bodies are loaded only for live questions below, never retained in history.
      return report ? { ...report, ...(report.status === "waiting" ? shorten(report.text, 0) : shorten(report.text)) } : undefined;
    });
  }
  /** Read projected history without requiring a live or healthy runtime state. */
  activity(id: string, options: { cursor?: string; limit?: number; maxBytes?: number; signal?: AbortSignal } = {}) {
    options.signal?.throwIfAborted();
    const spec = this.spec(id), cli = spec.cli ?? "pi";
    const session = nativeSession(readJson<SessionHandle | NativeSession>(path.join(this.directory(id), "session.json")));
    const threadId = session?.cli !== cli ? undefined : session.cli === "codex" ? session.threadId : session.sessionId;
    return readActivity({ ...options, id, cli, threadId, files: this.eventLogs(id) });
  }

  /** Read one persisted final report by identity, never via the current state's result pointer or cache. */
  getResult(id: string, runId: string): Report {
    this.spec(id);
    if (!idPattern.test(runId)) throw new Error("Invalid run id");
    let report: Report | undefined;
    try { report = readJson<Report>(path.join(this.directory(id), "reports", `${runId}-result.json`)); }
    catch (error) { throw new Error(`Cannot read result for subagent ${id}, run ${runId}: ${(error as Error).message}`); }
    if (report === undefined) throw new Error(`No final result for subagent ${id}, run ${runId}; do not substitute another run or assume success.`);
    if (!report || report.parentFile !== this.parentFile || report.agentId !== id || report.runId !== runId ||
      report.notificationId !== `${runId}-result` || !["completed", "failed", "stopped"].includes(report.status) || typeof report.text !== "string")
      throw new Error(`Invalid or foreign result for subagent ${id}, run ${runId}`);
    return report;
  }

  get(id: string): AgentView {
    return this.view(id, readJson<AgentState>(path.join(this.directory(id), "state.json")));
  }
  private view(id: string, snapshot: AgentState | undefined, receipt?: OperationReceipt): AgentView {
    const spec = this.spec(id), dir = this.directory(id);
    let state: (AgentState & { reclaimed?: AgentView["reclaimed"] }) | undefined = snapshot ? { ...snapshot } : undefined;
    // Operation acknowledgements are response-local, never part of a query view.
    if (state) delete (state as ControlResult).receipt;
    if (!state) throw new Error(`Subagent ${id} has no runtime state yet; inspect ${dir}`);
    if (state.id !== id || !idPattern.test(state.runId) || !["starting", "running", "waiting", "stopping", "completed", "failed", "stopped", "idle", "closed", "unreachable"].includes(state.phase)
      || !Number.isInteger(state.workerPid) || state.workerPid < 0 || !Number.isFinite(state.updatedAt) || typeof state.accepted !== "boolean"
      || typeof state.logFile !== "string" || !Array.isArray(state.questions) || state.questions.some(q => !q || typeof q.id !== "string" || typeof q.title !== "string" || !["select", "confirm", "input", "editor", "form"].includes(q.method)))
      throw new Error(`Invalid runtime state for subagent ${id}; inspect ${dir}`);
    let lockAbsent = false, lockMatches = false;
    // A reclaim needs the file itself to be gone: an empty lock record still claims the instance.
    const lockMissing = !existsSync(path.join(dir, "owner.lock"));
    if (state.protocolVersion !== undefined) {
      if (state.protocolVersion !== 2 || typeof state.runtimeId !== "string" || !idPattern.test(state.runtimeId) ||
        state.phase === "closed" && state.runtimeClosed !== true ||
        state.lastStatus !== undefined && !["completed", "failed", "stopped"].includes(state.lastStatus) ||
        state.runtimeClosed && !["completed", "failed", "stopped", "closed"].includes(state.phase))
        throw new Error(`Invalid runtime identity for subagent ${id}`);
      const owner = this.readOwner(dir);
      lockAbsent = lockMissing;
      lockMatches = owner.kind === "ok" && owner.value.runtimeId === state.runtimeId && owner.value.pid === state.workerPid;
      if (state.runtimeClosed && owner.kind === "absent") state = { ...state, phase: "closed" };
      else if (!lockMatches)
        state = { ...state, phase: "unreachable", error: "Runtime ownership is uncertain; inspect owner.lock. Previous run results are unchanged." };
      else if (state.runtimeClosed) state = { ...state, phase: "stopping" };
    }
    if (["starting", "running", "waiting", "stopping", "idle"].includes(state.phase) && !processAlive(state.workerPid)) {
      state = { ...state, phase: "unreachable", error: "The worker exited and runtime status is uncertain. Previous run results are unchanged. Do not start duplicate work; inspect the logs and owner.lock." };
    }
    // A reclaim frees the accounting of one runtime only. It applies to an unreachable runtime
    // whose ownership is absent or provably the same, never to a conflict or a newer runtime.
    if (state.phase === "unreachable" && state.protocolVersion === 2 && (lockAbsent || lockMatches)) {
      const reclaim = this.readReclaim(dir, id, state.runtimeId!);
      if (reclaim) state = { ...state, reclaimed: { at: reclaim.observedAt, evidence: reclaim.evidence, nativeReleaseConfirmed: false, continuation: "blocked" } };
    }
    const candidate = state.resultFile ? this.report(state.resultFile) : undefined;
    const report = candidate?.runId === state.runId && candidate.agentId === id && candidate.parentFile === this.parentFile ? candidate : undefined;
    const current = state.runId, phase = state.phase;
    // A resume writes its run directory before the worker replaces state.json. Report only runs
    // the persisted state has acknowledged, so a queued run is never paired with the previous
    // run's phase — that would read as "finished" while the new work has not started.
    const all = this.runs(id), acknowledged = all.findIndex((run) => run.runId === current), runs = acknowledged < 0 ? all : all.slice(0, acknowledged + 1);
    const history = runs.slice(-HISTORY_LIMIT).map<TaskRun>((run) => {
      const task = summarize(run.request.message);
      const outcome = this.report(path.join(dir, "reports", `${run.runId}-result.json`))?.status;
      const final = outcome === "completed" || outcome === "failed" || outcome === "stopped" ? outcome : undefined;
      return {
        runId: run.runId, startedAt: run.time, ...(task ? { task } : {}),
        // A run that left no result report has no verdict to report; never invent one.
        status: final ?? (run.runId === current && !["idle", "closed"].includes(phase) ? phase : "unknown"),
      };
    });
    const latest = history.at(-1);
    return { ...state, cli: spec.cli ?? "pi", role: spec.roleName, cwd: spec.cwd, ...(spec.workspace ? { workspace: spec.workspace, workspaceBaseline: spec.workspaceBaseline } : {}), history, runCount: runs.length,
      ...(latest?.runId === current && latest.task ? { task: latest.task } : {}), ...(report ? { text: report.text, truncated: report.truncated } : {}), ...(receipt ? { receipt } : {}) };
  }
  /** Preserves the existing projection: a missing or ownerless record means "no owner" for the phase. */
  private readOwner(dir: string): { kind: "absent" } | { kind: "ok"; value: { pid: number; runtimeId?: string } } {
    const file = path.join(dir, "owner.lock");
    if (!existsSync(file)) return { kind: "absent" };
    const value = readJson<{ pid: number; runtimeId?: string }>(file);
    return value && typeof value === "object" ? { kind: "ok", value } : { kind: "absent" };
  }
  private reclaimFile(dir: string, runtimeId: string): string {
    return path.join(dir, "reclaims", `${runtimeId}.json`);
  }
  /** A lock that cannot be read is an ownership conflict with a readable reason, not a raw JSON error. */
  private readOwnership(dir: string): { kind: "absent" } | { kind: "ok"; value: { pid: number; runtimeId?: string } } {
    try { return this.readOwner(dir); }
    catch (error) {
      throw new Error(`Ownership cannot be established: ${(error as Error).message} Nothing was reclaimed and no control request was sent.`);
    }
  }
  /** A reclaim counts only when its content names this parent, this instance and this exact runtime. */
  private readReclaim(dir: string, id: string, runtimeId: string): ReclaimRecord | undefined {
    if (!idPattern.test(runtimeId)) return undefined;
    let record: ReclaimRecord | undefined;
    // A damaged claim must not make the instance unreadable: it simply does not count.
    try { record = readJson<ReclaimRecord>(this.reclaimFile(dir, runtimeId)); } catch { return undefined; }
    const absent = (entry: ReclaimRecord["evidence"]["worker"] | undefined) =>
      !!entry && Number.isInteger(entry.pid) && entry.pid > 0 && entry.absent === true && entry.criterion === "ESRCH";
    if (!record || record.version !== 1 || record.parentFile !== this.parentFile || record.id !== id || record.runtimeId !== runtimeId
      || !absent(record.evidence?.worker) || !absent(record.evidence?.cli)
      || record.nativeReleaseConfirmed !== false || record.continuation !== "blocked" || !Number.isFinite(record.observedAt)) return undefined;
    return record;
  }
  private viewWithReclaim(view: AgentView, record: ReclaimRecord): AgentView {
    return { ...view, receipt: { operation: "reclaim", status: "reclaimed", runId: view.runId, runtimeId: record.runtimeId,
      accounting: { active: false, resident: false }, evidence: record.evidence, nativeReleaseConfirmed: false, continuation: "blocked" } };
  }

  /**
   * Reclaim the accounting of one unreachable runtime whose worker and CLI are both reliably gone.
   * This never claims a native release, never unblocks resuming the instance and never touches the
   * lock: the worker's record stays the execution truth, and its absence is not re-read here.
   */
  async reclaim(id: string, runtimeId: string): Promise<AgentView> {
    const dir = this.directory(id);
    this.spec(id);
    const raw = readJson<AgentState>(path.join(dir, "state.json"));
    if (!raw) throw new Error(`Subagent ${id} has no runtime state; nothing was reclaimed. Inspect ${dir}`);
    // Capture the target before observing anything: a later state, or a new runtime, must not
    // inherit this decision.
    const target = { runtimeId: raw.protocolVersion === 2 ? raw.runtimeId : undefined, workerPid: raw.workerPid, cliPid: raw.cliPid };
    if (!idPattern.test(runtimeId) || target.runtimeId !== runtimeId)
      throw new Error(`Runtime ${runtimeId} is not the runtime recorded for subagent ${id} (${target.runtimeId ?? "none"}); nothing was reclaimed. Query the instance for its current runtime ID.`);
    const view = this.get(id);
    // Identity is captured once and re-checked here: a runtime that replaced the target between the
    // two reads must not inherit a decision made about its predecessor.
    if (view.runtimeId !== runtimeId)
      throw new Error(`Runtime identity changed to ${view.runtimeId ?? "none"} while reclaiming ${runtimeId}; nothing was reclaimed. Query the instance for its current runtime ID.`);
    if (view.phase !== "unreachable")
      throw new Error(`Runtime ${runtimeId} is ${view.phase}, not unreachable; stop a live runtime instead of reclaiming its accounting. Nothing was reclaimed.`);
    const owner = this.readOwnership(dir);
    // An unowned but present lock file still blocks the reclaim: only a missing file or a full match counts.
    if (existsSync(path.join(dir, "owner.lock")) && !(owner.kind === "ok" && owner.value.runtimeId === runtimeId && owner.value.pid === target.workerPid))
      throw new Error(`Owner conflict for runtime ${runtimeId}: owner.lock ${owner.kind === "ok" ? `records pid ${owner.value.pid} and runtime ${owner.value.runtimeId ?? "none"}` : "names no owner"}. Check state.json and owner.lock; nothing was reclaimed and no control request was sent.`);
    // Idempotency is only valid while the checks above still hold, so it comes after them.
    const existing = this.readReclaim(dir, id, runtimeId);
    if (existing) return this.viewWithReclaim(view, existing);
    const refuse = (name: string, pid: number | undefined, state: string): void => {
      if (state === "absent") return;
      const detail = state === "alive" ? `PID ${pid} still exists` : `the absence of PID ${pid} could not be verified`;
      throw new Error(`${name} ${detail}; this operation does not terminate processes and unknown is not absent. Nothing was reclaimed. Inspect the logs and retry reclaim after that process exits.`);
    };
    refuse("Worker", target.workerPid, liveness(target.workerPid));
    // Without a recorded CLI pid its absence cannot be established at all: refuse, do not guess.
    if (!Number.isInteger(target.cliPid) || (target.cliPid ?? 0) <= 0)
      throw new Error(`Subagent ${id} records no usable CLI PID, so its absence cannot be established; nothing was reclaimed. Inspect ${dir}`);
    refuse("CLI", target.cliPid, liveness(target.cliPid));
    const record: ReclaimRecord = {
      version: 1, parentFile: this.parentFile, id, runtimeId, observedAt: Date.now(),
      evidence: { worker: { pid: target.workerPid, absent: true, criterion: "ESRCH" }, cli: { pid: target.cliPid!, absent: true, criterion: "ESRCH" } },
      nativeReleaseConfirmed: false, continuation: "blocked",
    };
    const file = this.reclaimFile(dir, runtimeId);
    const written = writeJsonExclusive(file, record);
    const effective = written ? record : this.readReclaim(dir, id, runtimeId);
    if (!effective) throw new Error(`A reclaim record for runtime ${runtimeId} exists but is not usable; nothing was changed. Inspect ${file}`);
    return this.viewWithReclaim(this.get(id), effective);
  }

  list(): AgentView[] {    return directories(this.root).filter((id) => idPattern.test(id)).map((id) => {
      try { return this.get(id); }
      catch (error) {
        // Inventory is not a control authorization. Keep the record visible without
        // inventing a run/session or preventing healthy siblings from reporting.
        const dir = this.directory(id);
        return { id, runId: "", role: "Record unavailable", cwd: "", phase: "unreachable", workerPid: 0,
          updatedAt: 0, accepted: false, questions: [], logFile: dir,
          error: `Record unavailable: ${(error as Error).message}. History and ownership are unknown; inspect ${dir} before any retry.` };
      }
    });
  }

  /** Only this parent's validated runs, oldest first. Requests carry their own creation time. */
  private runs(id: string): { runId: string; folder: string; time: number; request: StartRequest }[] {
    const root = path.join(this.directory(id), "runs");
    const runs: { runId: string; folder: string; time: number; request: StartRequest }[] = [];
    for (const runId of directories(root)) {
      if (!idPattern.test(runId)) continue;
      const folder = path.join(root, runId), file = path.join(folder, "request.json");
      // A run directory exists before its request file is durable; skip it rather than failing a poll.
      const request = this.readHistory(file, (mtimeMs) => {
        const saved = readJson<StartRequest>(file);
        return saved ? { runId: saved.runId, message: summarize(saved.message) ?? "", createdAt: saved.createdAt ?? mtimeMs, logFile: saved.logFile } : undefined;
      });
      if (!request || request.runId !== runId) continue;
      runs.push({ runId, folder, request, time: request.createdAt });
    }
    return runs.sort((a, b) => a.time - b.time || a.runId.localeCompare(b.runId));
  }

  /** Event logs for this instance, ordered like its task history. */
  eventLogs(id: string): string[] {
    this.spec(id);
    const runs = this.runs(id);
    if (!runs.length) return [];
    const root = path.join(this.directory(id), "runs"), realInstance = realpathSync(this.directory(id));
    const logs = runs.map(run => {
      const file = run.request.logFile === undefined ? path.join(run.folder, "events.jsonl") : path.resolve(run.request.logFile);
      const relative = path.relative(root, file), parts = relative.split(path.sep);
      if (parts.length !== 2 || !idPattern.test(parts[0]) || parts[1] !== "events.jsonl") throw new Error("Invalid or outside-instance runtime log reference");
      // Anchor at the instance, not runs/ (which could itself be a symlink). Resolve
      // the parent even for missing logs so a later-created file cannot bypass this check.
      const resolved = existsSync(file) ? realpathSync(file) : path.join(realpathSync(path.dirname(file)), "events.jsonl");
      const actual = path.relative(realInstance, resolved).split(path.sep);
      if (actual.length !== 3 || actual[0] !== "runs" || !idPattern.test(actual[1]) || actual[2] !== "events.jsonl") throw new Error("Runtime log reference escapes the instance");
      return resolved;
    });
    return [...new Set(logs)];
  }

  /**
   * One parent session, counted across roles in two dimensions: concurrent turns (a step that may still
   * execute) and resident runtimes (a slot not yet released). Both are settable; `0` disables one.
   */
  private caps(): AdmissionCaps { return resolveCaps(); }

  /**
   * Refuse before anything is written or started; the count comes from disk so every controller agrees.
   * A new runtime takes both dimensions; a new run inside a resident runtime only takes a turn slot,
   * because the runtime it runs in is already counted. The returned token must be settled afterwards.
   */
  private admit(id: string, options: { priorRunId?: string; newRuntime?: boolean } = {}): string {
    const { active, resident } = this.caps();
    const prefix = `${this.root}\0`;
    const views = this.list();
    const newRuntime = options.newRuntime !== false;
    // One reservation per instance: a second run on one instance is already impossible, and replacing
    // the older token keeps an uncertain attempt from accumulating slots.
    for (const [token, reservation] of [...admitting]) if (reservation.id === id) admitting.delete(token);
    const pending = pruneVisibleReservations(admitting, prefix, views);
    const occupied = views.filter(occupiesRuntime);
    const residentTotal = occupied.length + pending.resident;
    if (newRuntime && resident !== undefined && residentTotal >= resident)
      throw new Error(`${residentTotal} of ${resident} managed runtimes are already occupied in this parent session (${this.residentCapName()}); a runtime keeps its slot until its release is confirmed. This dispatch was refused.`);
    const activeTotal = occupied.filter(countsAsActive).length + pending.active;
    if (active !== undefined && activeTotal >= active)
      throw new Error(`${activeTotal} of ${active} concurrent turns are already active in this parent session (PI_CLI_SUBAGENTS_MAX_ACTIVE); this dispatch was refused.`);
    const token = `${prefix}${id}\0${++nextReservation}`;
    admitting.set(token, { id, newRuntime, ...(options.priorRunId !== undefined ? { priorRunId: options.priorRunId } : {}) });
    return token;
  }

  /** Name the variable that produced the resident cap, so a refusal stays actionable. */
  private residentCapName(): string {
    // The legacy name only applies when it is the one configured; an unconfigured cap names the default's variable.
    return process.env.PI_CLI_SUBAGENTS_MAX_RUNTIMES !== undefined && process.env.PI_CLI_SUBAGENTS_MAX_RESIDENT === undefined
      ? "PI_CLI_SUBAGENTS_MAX_RUNTIMES" : "PI_CLI_SUBAGENTS_MAX_RESIDENT";
  }

  /**
   * Drop a reservation once the disk accounts for the attempt. A missing or old run id on a settled
   * phase proves no run started; an unreadable record keeps the slot while a runtime claim remains,
   * because a lost response does not prove the run failed.
   */
  private settleAdmission(token: string): void {
    const reservation = admitting.get(token);
    if (!reservation) return;
    try {
      const view = this.get(reservation.id);
      if (view.runId !== reservation.priorRunId || ["idle", "completed", "failed", "stopped", "closed"].includes(view.phase)) admitting.delete(token);
    } catch {
      if (!existsSync(path.join(this.directory(reservation.id), "owner.lock"))) admitting.delete(token);
    }
  }

  async spawn(roleName: string, role: Role, cwd: string, message: string, workspace?: string): Promise<AgentView> {
    if (!message.trim()) throw new Error("Task must not be empty");
    role = validateRoleFile({ launch: role }, "Subagent role").launch;
    const id = randomUUID(), dir = this.directory(id);
    const admission = this.admit(id, { newRuntime: true });
    const start = async (directory: string, baseline?: AgentSpec["workspaceBaseline"], notice?: string): Promise<AgentView> => {
      directory = path.resolve(directory);
      if (!statSync(directory).isDirectory()) throw new Error("cwd must be an existing directory");
      const selected = role.cli === "codex" ? this.codex ?? { launch: codexLaunch(), home: codexHome() } :
        role.cli === "claude" ? this.claude ?? { launch: claudeLaunch(), home: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude") } : undefined;
      const spec: AgentSpec = { version: role.cli === "claude" ? 3 : selected ? 2 : 1,
        ...(selected ? role.cli === "claude" ? { cli: "claude", claudeHome: path.resolve(selected.home) } : { cli: "codex", codexHome: path.resolve(selected.home) } : {}),
        id, parentFile: this.parentFile, cwd: directory, roleName, role,
        launch: selected?.launch ?? this.launch, createdAt: Date.now(), ...(workspace ? { workspace, workspaceBaseline: baseline } : {}) };
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeJson(path.join(dir, "spec.json"), spec);
      return this.start(id, notice ? `${message}\n\n[Workspace baseline]\n${notice}` : message);
    };
    try {
      if (workspace !== undefined) return await this.workspaces.runAgent(workspace, id, (ws, notice) => start(ws.cwd, { commit: ws.baseCommit, revision: ws.revision }, notice));
      this.workspaces.assertShared(cwd);
      return await start(cwd);
    } finally { this.settleAdmission(admission); }
  }

  private async start(id: string, message: string, session?: NativeSession | SessionHandle, operation: "start" | "send" = "start"): Promise<AgentView> {
    const dir = this.directory(id);
    if (existsSync(path.join(dir, "owner.lock"))) throw new Error("The previous worker still owns this session or a stale lock remains. Inspect it before resuming; concurrent owners are not allowed.");
    if (session && "sessionFile" in session && !existsSync(session.sessionFile)) throw new Error(`Original session file is missing: ${session.sessionFile}; will not silently create a new session.`);
    const runId = randomUUID(), runDir = path.join(dir, "runs", runId);
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const priorStart = readJson<AgentState>(path.join(dir, "state.json"))?.startedAt;
    const initial: StartRequest = { runId, message, createdAt: Math.max(Date.now(), Number.isFinite(priorStart) ? priorStart! + 1 : 0), session };
    writeJson(path.join(runDir, "request.json"), initial);
    const fd = openSync(path.join(runDir, "worker.log"), "a", 0o600);
    let child: ChildProcess | undefined;
    try {
      child = spawn(process.execPath, [workerFile, dir, runId], {
        detached: true, windowsHide: true, stdio: ["ignore", fd, fd],
      });
      child.on("error", (error) => writeJson(path.join(runDir, "error.json"), { error: error.message }));
      child.unref();
    } finally { closeSync(fd); }
    let observed: AgentState | undefined;
    try {
      const result = await waitUntil(`Subagent ${id} startup`, () => {
        const failure = readJson<{ error: string }>(path.join(runDir, "error.json"));
        if (failure) throw new Error(failure.error);
        const state = readJson<AgentState>(path.join(dir, "state.json"));
        if (state && state.runId === runId) {
          observed = state;
          const view = this.view(id, state);
          if (view.phase === "unreachable") throw new Error(view.error);
          if (view.accepted || ["waiting", "failed", "stopped", "completed", "idle", "closed"].includes(view.phase)) return view;
        }
        // A worker that dies before it acknowledges the run records nothing of its own, so the
        // exit is the only evidence. Reporting it here replaces the whole startup timeout wait.
        if (child && (child.exitCode !== null || child.signalCode !== null))
          throw new Error(`Worker exited (${child.exitCode ?? child.signalCode}) before accepting the task; work may already have run, so inspect ${path.join(runDir, "worker.log")} before retrying`);
        return undefined;
      }, 45_000);
      return { ...result, receipt: { operation, status: result.accepted ? "accepted" : "unconfirmed", runId, ...(result.runtimeId ? { runtimeId: result.runtimeId } : {}) } };
    } catch (error) {
      throw this.diagnostic(id, operation, `run ${runId}: ${(error as Error).message}; records retained at ${dir}`, observed);
    }
  }

  private diagnostic(id: string, operation: string, error: unknown, state?: Pick<AgentState, "runId" | "runtimeId">): Error {
    // Workspace choices carry revision/inheritance proof needed by the human UI.
    if (error instanceof WorkspaceDecisionRequired) return error;
    // Transport/server errors may already carry the actual captured identity.
    if (error instanceof Error && (error.message.startsWith(`Subagent ${id},`) || error.message.includes(`for subagent ${id},`))) return error;
    if (!state) { try { state = this.get(id); } catch { /* Do not hide the original failure with a diagnostic read. */ } }
    return new Error(`${operation} for subagent ${id}${state ? `, run ${state.runId}, runtime ${state.runtimeId ?? "legacy"}` : ""}: ${error instanceof Error ? error.message : String(error)}`);
  }

  private async request(id: string, input: Control, state: AgentView = this.get(id)): Promise<ControlResult> {
    try {
      if (!processAlive(state.workerPid)) throw new Error("Worker has exited; inspect the final state");
      const endpoint = readJson<Endpoint>(path.join(this.directory(id), "endpoint.json"));
      if (!endpoint || endpoint.runId !== state.runId || (state.protocolVersion === 2 &&
        (endpoint.protocolVersion !== 2 || endpoint.runtimeId !== state.runtimeId))) throw new Error("Worker is not ready, or the connection record is stale");
      const result = await control(endpoint, input);
      const operation = input.type === "close" ? "stop" : input.type === "start" || input.type === "send" || input.type === "interrupt" ? input.type : undefined;
      // A pre-P3 worker's accepted flag describes its initial task, not this command.
      return operation ? { ...result, receipt: result.receipt ?? { operation, status: "unconfirmed", runId: result.runId,
        ...(result.runtimeId ? { runtimeId: result.runtimeId } : {}) } } : result;
    } catch (error) { throw this.diagnostic(id, input.type, error, state); }
  }

  async send(id: string, message: string, mode: Delivery = "steer", options: ResumeOptions = {}): Promise<AgentView> {
    if (!message.trim()) throw new Error("Message must not be empty");
    const spec = this.spec(id);
    if (!spec.workspace && (options.baseline !== undefined || options.includeUncommitted !== undefined)) throw new Error("Baseline choices require a managed workspace");
    const beforeSync = async (): Promise<void> => {
      let state = this.get(id);
      if (["starting", "running", "waiting", "stopping", "unreachable"].includes(state.phase)) throw new Error("Cannot sync a running or uncertain instance; wait for it to finish or inspect it first");
      if (state.phase === "idle") { await this.close(id, true); state = this.get(id); }
      await this.waitForRelease(state, "Sync writer release", 15_000);
      const session = nativeSession(state.session ?? (state.sessionFile && state.sessionId ? { sessionFile: state.sessionFile, sessionId: state.sessionId } : undefined));
      if (!session || session.cli !== (spec.cli ?? "pi")) throw new Error("No resumable original session; cannot sync for continuation");
      if (session.cli === "pi") {
        if (!existsSync(session.sessionFile)) throw new Error(`Original session file is missing: ${session.sessionFile}; no synchronization was performed`);
        try { await inspectPiSession(session); }
        catch (error) { throw new Error(`Pi original-session preflight failed; no synchronization was performed. ${(error as Error).message}`); }
      } else if (session.cli === "claude") {
        try { inspectClaudeSession(spec, session); }
        catch (error) { throw new Error(`Claude original-session preflight failed; no synchronization was performed. ${(error as Error).message}`); }
      } else {
        const logFile = path.join(this.directory(id), `preflight-${randomUUID()}.jsonl`);
        try {
          await new CodexAdapter({ spec, session, logFile, onEvent: () => {} }).inspectSession();
        } catch (error) { throw new Error(`Codex original-thread preflight failed; no synchronization was performed. ${(error as Error).message}; inspect ${logFile}`); }
      }
    };
    const send = async (notice?: string): Promise<AgentView> => {
      const prompt = notice ? `${message}\n\n[Workspace baseline]\n${notice}` : message;
      let state = this.get(id);
      if (state.phase === "unreachable") throw new Error(state.error);
      if (state.phase === "idle") {
        // A new run on a resident instance takes a turn slot too; the instance is already visible, so
        // the reservation is settled against its new run id instead of its existence.
        const admission = this.admit(id, { priorRunId: state.runId, newRuntime: false });
        try {
          const result = await this.request(id, { type: "start", message: prompt });
          return this.view(id, result, result.receipt && { ...result.receipt, operation: "send" });
        }
        finally { this.settleAdmission(admission); }
      }
      if (["starting", "running", "waiting"].includes(state.phase)) {
        if (spec.cli === "codex" && mode === "followUp") throw new Error("Codex followUp while running is not supported; wait for this run to finish");
        const result = await this.request(id, { type: "send", message: prompt, mode });
        return this.view(id, result, result.receipt);
      }
      await this.waitForRelease(state, "Previous worker release", 15_000);
      state = this.get(id);
      const session = nativeSession(state.session ?? (state.sessionFile && state.sessionId ? { sessionFile: state.sessionFile, sessionId: state.sessionId } : undefined));
      if (!session || session.cli !== (spec.cli ?? "pi")) throw new Error("No resumable original session; will not silently create a new session");
      if (session.cli === "codex" && session.codexHome !== spec.codexHome) throw new Error("Codex native home changed; refusing to resume a different session store");
      if (session.cli === "claude") inspectClaudeSession(spec, session);
      // Resuming a released instance starts a new runtime, so it needs a free slot like spawn does.
      const admission = this.admit(id, { priorRunId: state.runId, newRuntime: true });
      try { return await this.start(id, prompt, session, "send"); }
      finally { this.settleAdmission(admission); }
    };
    try {
      if (!spec.workspace) return await send();
      return await this.workspaces.runAgent(spec.workspace, id, async (ws, notice) => {
        const state = await send(notice);
        if (state.accepted || state.phase === "completed" || state.lastStatus === "completed") {
          const workspaceBaseline = { commit: ws.baseCommit, revision: ws.revision };
          writeJson(path.join(this.directory(id), "spec.json"), { ...spec, workspaceBaseline });
          return { ...state, workspaceBaseline };
        }
        // send() already validated and normalized the raw snapshot. A closing view
        // can be stopping + runtimeClosed while owner.lock is still being released.
        return state;
      }, options, beforeSync);
    } catch (error) { throw this.diagnostic(id, "send", error); }
  }

  /** Lock release follows CLI reaping; a terminal PID may already belong to another process. */
  private async waitForRelease(state: AgentView, label: string, timeout: number): Promise<void> {
    const file = path.join(this.directory(state.id), "owner.lock");
    await waitUntil(label, () => {
      const owner = readJson<{ pid: number; runId: string; runtimeId?: string }>(file);
      if (owner === undefined) return true;
      if (!owner || owner.pid !== state.workerPid || (state.protocolVersion === 2 ? owner.runtimeId !== state.runtimeId : owner.runId !== state.runId) || !processAlive(owner.pid))
        throw new Error(`A different owner or stale lock remains at ${file}; inspect it before retrying. No lock was reclaimed.`);
      return undefined;
    }, timeout);
  }

  async interrupt(id: string): Promise<AgentView> {
    const state = this.get(id);
    try {
      if (state.phase === "unreachable") throw new Error(state.error);
      if (["completed", "failed", "stopped", "closed"].includes(state.phase)) {
        await this.waitForRelease(state, "Interrupt closed runtime", 15_000);
        return { ...state, receipt: { operation: "interrupt", status: "not_running", runId: state.runId,
          ...(state.runtimeId ? { runtimeId: state.runtimeId } : {}) } };
      }
      // Even an observed idle runtime can become busy. The worker decides against
      // its serialized, captured run; do not manufacture a verdict from this view.
      const result = await this.request(id, { type: "interrupt" });
      return this.view(id, result, result.receipt);
    } catch (error) { throw this.diagnostic(id, "interrupt", error, state); }
  }

  async close(id: string, onlyIdle = false, expected?: { runId: string; runtimeId?: string }, preserveAccepted = false): Promise<AgentView> {
    const state = this.get(id);
    try {
      // A reclaim freed only the accounting; there is no native release left to confirm here.
      if (state.reclaimed) throw new Error(`Runtime ${state.runtimeId} had its accounting reclaimed without a native release confirmation, so stop has nothing to confirm. This instance cannot be continued in this version; start a new instance for further work.`);
      if (state.phase === "unreachable" && (!state.runtimeId || !processAlive(state.workerPid))) throw new Error(state.error);
      if (expected && ((!onlyIdle && !preserveAccepted) || onlyIdle && state.protocolVersion !== 2 || state.runId !== expected.runId || state.runtimeId !== expected.runtimeId))
        throw new Error(`Captured run ${expected.runId}, runtime ${expected.runtimeId ?? "legacy"} no longer matches; it was not closed`);
      if (onlyIdle && state.phase !== "idle") throw new Error("Runtime is no longer idle; it was not closed");
      // Keep the checked idle snapshot bound through endpoint selection; the worker
      // rechecks its token and idle state inside the existing control queue.
      if (!["completed", "failed", "stopped", "stopping", "closed"].includes(state.phase))
        await this.request(id, { type: "close", ...(onlyIdle ? { onlyIdle: true } : {}), ...(preserveAccepted ? { preserveAccepted: true } : {}) }, expected || onlyIdle ? state : undefined);
      await this.waitForRelease(state, "Subagent shutdown", 30_000);
      const result = this.get(id);
      if (onlyIdle && (result.runId !== state.runId || result.runtimeId !== state.runtimeId))
        throw new Error("Idle release confirmation identity changed; inspect before retrying");
      const confirmed = result.protocolVersion === 2 && result.runtimeId === state.runtimeId && result.runtimeClosed === true && result.phase === "closed";
      return { ...result, receipt: { operation: "stop", status: confirmed ? "released" : "unconfirmed", runId: result.runId,
        ...(result.runtimeId ? { runtimeId: result.runtimeId } : {}) } };
    } catch (error) { throw this.diagnostic(id, "stop", error, state); }
  }

  async reply(id: string, questionId: string, answer: Pick<Extract<Control, { type: "reply" }>, "value" | "answers" | "confirmed" | "cancelled">, decision: { actor: "human" | "parent"; reason?: string } = { actor: "human" }): Promise<AgentView> {
    return this.view(id, await this.request(id, { type: "reply", id: questionId, ...answer, ...decision }));
  }

  reports(now = Date.now(), states: readonly AgentView[] = this.list()): Report[] {
    const reports: Report[] = [];
    for (const state of states) {
      // An inventory diagnostic has no verified execution to report or receipt to invent.
      if (!state.runId) continue;
      const folder = path.join(this.directory(state.id), "reports");
      let files: string[];
      try { files = jsonFiles(folder); }
      catch (error) {
        console.error(`[pi-cli-subagents] Could not list reports for subagent ${state.id}; inspect ${folder}:`, error);
        files = [];
      }
      for (const file of files) {
        const reportFile = path.join(folder, file);
        try {
          let report = this.report(reportFile);
          if (!report || report.parentFile !== this.parentFile) continue;
          const questionId = report.questionId;
          const pending = report.status === "waiting" ? state.questions.find((q) => q.id === questionId) : undefined;
          if (report.status === "waiting" && !pending) continue;
          if (pending) {
            const full = readJson<Report>(reportFile);
            if (!full || full.status !== "waiting" || full.parentFile !== this.parentFile || full.agentId !== state.id ||
              full.runId !== report.runId || full.notificationId !== report.notificationId || full.questionId !== pending.id || typeof full.text !== "string")
              throw new Error("Waiting report changed or does not belong to this pending request");
            report = { ...full, truncated: false };
          }
          // Carry the live policy, including native human-only restrictions, without rewriting
          // stored reports. Resolved requests were filtered above and must not be re-announced.
          reports.push(pending ? { ...report, request: { method: pending.method, options: pending.options,
            parentPolicy: pending.parentPolicy, humanOnly: pending.humanOnly, ...(pending.kind ? { kind: pending.kind } : {}),
            ...(pending.fields ? { fields: pending.fields } : {}), ...(pending.isBlocking !== undefined ? { isBlocking: pending.isBlocking } : {}) } } : { ...report });
        } catch (error) {
          console.error(`[pi-cli-subagents] Could not read report for subagent ${state.id}; inspect ${reportFile}:`, error);
        }
      }
      if (state.phase === "unreachable") reports.push({
        notificationId: `${state.runtimeId ?? state.runId}-unreachable`, agentId: state.id, runId: state.runId, parentFile: this.parentFile,
        status: "failed", time: state.updatedAt, text: "", error: state.error, logFile: state.logFile,
      });
      if (["running", "starting"].includes(state.phase) && now - state.updatedAt >= 15 * 60_000) reports.push({
        notificationId: `${state.runId}-inactive`, agentId: state.id, runId: state.runId, parentFile: this.parentFile,
        status: "stalled", time: state.updatedAt + 15 * 60_000,
        text: "No activity for 15 minutes; the child may still be running. Inspect with subagent_query or /agents; do not assume failure or start duplicate work.",
        logFile: state.logFile,
      });
    }
    return reports.sort((a, b) => a.time - b.time);
  }
}
