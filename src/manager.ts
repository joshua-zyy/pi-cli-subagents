import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { control } from "./control.js";
import { codexHome, codexLaunch } from "./codex-launch.js";
import { CodexAdapter } from "./codex-adapter.js";
import { nativeSession } from "./cli-adapter.js";
import { WorkspaceStore, type ResumeOptions } from "./workspace.js";
import { directories, jsonFiles, processAlive, readJson, shorten, waitUntil, writeJson } from "./storage.js";
import type { AgentSpec, AgentState, AgentView, Control, Delivery, Endpoint, Launch, NativeSession, Report, Role, SessionHandle, StartRequest, TaskRun } from "./types.js";

const workerFile = fileURLToPath(new URL("./worker.js", import.meta.url));
const idPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
/** Enough recent assignments to choose a reusable instance without pasting a whole work history. */
const HISTORY_LIMIT = 5;

/** One-line assignment summary: the parent matches an instance to its work, not to a transcript. */
function summarize(message: string | undefined, limit = 200): string | undefined {
  const flat = typeof message === "string" ? message.replace(/\s+/g, " ").trim().slice(0, limit) : "";
  return flat || undefined;
}

export class AgentManager {
  readonly root: string;
  readonly parentFile: string;
  readonly workspaces: WorkspaceStore;
  constructor(parentFile: string, private readonly launch: Launch, private readonly codex?: { launch: Launch; home: string }) {
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
    if (!spec || ![1, 2].includes(spec.version) || (spec.version === 2 && (spec.cli !== "codex" || !spec.codexHome)) || spec.parentFile !== this.parentFile || spec.id !== id) throw new Error("This subagent does not belong to the current parent session, or its record is missing");
    return spec;
  }
  get(id: string): AgentView {
    const spec = this.spec(id), dir = this.directory(id);
    let state = readJson<AgentState>(path.join(dir, "state.json"));
    if (!state) throw new Error(`Subagent ${id} has no runtime state yet; inspect ${dir}`);
    if (["starting", "running", "waiting", "stopping"].includes(state.phase) && !processAlive(state.workerPid)) {
      state = { ...state, phase: "unreachable", error: "The worker exited and task status is uncertain. Do not start duplicate work; inspect the logs and owner.lock." };
    }
    const report = state.resultFile ? readJson<Report>(state.resultFile) : undefined;
    const current = state.runId, phase = state.phase;
    // A resume writes its run directory before the worker replaces state.json. Report only runs
    // the persisted state has acknowledged, so a queued run is never paired with the previous
    // run's phase — that would read as "finished" while the new work has not started.
    const all = this.runs(id), acknowledged = all.findIndex((run) => run.runId === current), runs = acknowledged < 0 ? all : all.slice(0, acknowledged + 1);
    const history = runs.slice(-HISTORY_LIMIT).map<TaskRun>((run) => {
      const task = summarize(run.request.message);
      const outcome = readJson<Report>(path.join(dir, "reports", `${run.runId}-result.json`))?.status;
      const final = outcome === "completed" || outcome === "failed" || outcome === "stopped" ? outcome : undefined;
      return {
        runId: run.runId, startedAt: run.time, ...(task ? { task } : {}),
        // A run that left no result report has no verdict to report; never invent one.
        status: final ?? (run.runId === current ? phase : "unknown"),
      };
    });
    const latest = history.at(-1);
    return { ...state, cli: spec.cli ?? "pi", role: spec.roleName, cwd: spec.cwd, ...(spec.workspace ? { workspace: spec.workspace, workspaceBaseline: spec.workspaceBaseline } : {}), history, runCount: runs.length,
      ...(latest?.runId === current && latest.task ? { task: latest.task } : {}), ...(report ? shorten(report.text) : {}) };
  }
  list(): AgentView[] { return directories(this.root).filter((id) => idPattern.test(id)).map((id) => this.get(id)); }

  /** Only this parent's validated runs, oldest first. Requests carry their own creation time. */
  private runs(id: string): { runId: string; folder: string; time: number; request: StartRequest }[] {
    const root = path.join(this.directory(id), "runs");
    const runs: { runId: string; folder: string; time: number; request: StartRequest }[] = [];
    for (const runId of directories(root)) {
      if (!idPattern.test(runId)) continue;
      const folder = path.join(root, runId), file = path.join(folder, "request.json");
      // A run directory exists before its request file is durable; skip it rather than failing a poll.
      const request = readJson<StartRequest>(file);
      if (!request || request.runId !== runId) continue;
      try { runs.push({ runId, folder, request, time: request.createdAt ?? statSync(file).mtimeMs }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return runs.sort((a, b) => a.time - b.time || a.runId.localeCompare(b.runId));
  }

  /** Event logs for this instance, ordered like its task history. */
  eventLogs(id: string): string[] {
    this.spec(id);
    return this.runs(id).map((run) => path.join(run.folder, "events.jsonl"));
  }

  async spawn(roleName: string, role: Role, cwd: string, message: string, workspace?: string): Promise<AgentView> {
    if (!message.trim()) throw new Error("Task must not be empty");
    if (role.cli === "codex" && (!role.model || role.provider || role.thinking)) throw new Error("Codex requires an explicit model without Pi provider/thinking fields");
    if (role.cli !== "codex" && role.effort) throw new Error("Codex effort requires cli: codex");
    const id = randomUUID(), dir = this.directory(id);
    const start = async (directory: string, baseline?: AgentSpec["workspaceBaseline"], notice?: string): Promise<AgentView> => {
      directory = path.resolve(directory);
      if (!statSync(directory).isDirectory()) throw new Error("cwd must be an existing directory");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const selected = role.cli === "codex" ? this.codex ?? { launch: codexLaunch(), home: codexHome() } : undefined;
      const spec: AgentSpec = { version: selected ? 2 : 1, ...(selected ? { cli: "codex", codexHome: path.resolve(selected.home) } : {}),
        id, parentFile: this.parentFile, cwd: directory, roleName, role,
        launch: selected?.launch ?? this.launch, createdAt: Date.now(), ...(workspace ? { workspace, workspaceBaseline: baseline } : {}) };
      writeJson(path.join(dir, "spec.json"), spec);
      return this.start(id, notice ? `${message}\n\n[Workspace baseline]\n${notice}` : message);
    };
    if (workspace !== undefined) return this.workspaces.runAgent(workspace, id, (ws, notice) => start(ws.cwd, { commit: ws.baseCommit, revision: ws.revision }, notice));
    this.workspaces.assertShared(cwd);
    return start(cwd);
  }

  private async start(id: string, message: string, session?: NativeSession | SessionHandle): Promise<AgentView> {
    const dir = this.directory(id);
    if (existsSync(path.join(dir, "owner.lock"))) throw new Error("The previous worker still owns this session or a stale lock remains. Inspect it before resuming; concurrent owners are not allowed.");
    if (session && "sessionFile" in session && !existsSync(session.sessionFile)) throw new Error(`Original session file is missing: ${session.sessionFile}; will not silently create a new session.`);
    const runId = randomUUID(), runDir = path.join(dir, "runs", runId);
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const initial: StartRequest = { runId, message, createdAt: Date.now(), session };
    writeJson(path.join(runDir, "request.json"), initial);
    const fd = openSync(path.join(runDir, "worker.log"), "a", 0o600);
    try {
      const child = spawn(process.execPath, [workerFile, dir, runId], {
        detached: true, windowsHide: true, stdio: ["ignore", fd, fd],
      });
      child.on("error", (error) => writeJson(path.join(runDir, "error.json"), { error: error.message }));
      child.unref();
    } finally { closeSync(fd); }
    try {
      return await waitUntil(`Subagent ${id} startup`, () => {
        const failure = readJson<{ error: string }>(path.join(runDir, "error.json"));
        if (failure) throw new Error(failure.error);
        const state = readJson<AgentState>(path.join(dir, "state.json"));
        if (!state || state.runId !== runId) return undefined;
        const view = this.get(id);
        if (view.phase === "unreachable") throw new Error(view.error);
        return view.accepted || ["waiting", "failed", "stopped", "completed"].includes(view.phase) ? view : undefined;
      }, 45_000);
    } catch (error) {
      throw new Error(`Subagent ${id}: ${(error as Error).message}; records retained at ${dir}`);
    }
  }

  private async request(id: string, input: Control): Promise<void> {
    const state = this.get(id);
    if (!processAlive(state.workerPid)) throw new Error("Worker has exited; inspect the final state");
    const endpoint = readJson<Endpoint>(path.join(this.directory(id), "endpoint.json"));
    if (!endpoint || endpoint.runId !== state.runId) throw new Error("Worker is not ready, or the connection record is stale");
    await control(endpoint, input);
  }

  async send(id: string, message: string, mode: Delivery = "steer", options: ResumeOptions = {}): Promise<AgentView> {
    if (!message.trim()) throw new Error("Message must not be empty");
    const spec = this.spec(id);
    if (!spec.workspace && (options.baseline !== undefined || options.includeUncommitted !== undefined)) throw new Error("Baseline choices require a managed workspace");
    const beforeSync = async (): Promise<void> => {
      const state = this.get(id);
      if (["starting", "running", "waiting", "stopping", "unreachable"].includes(state.phase)) throw new Error("Cannot sync a running or uncertain instance; wait for it to finish or inspect it first");
      const session = nativeSession(state.session ?? (state.sessionFile && state.sessionId ? { sessionFile: state.sessionFile, sessionId: state.sessionId } : undefined));
      if (!session || session.cli !== (spec.cli ?? "pi")) throw new Error("No resumable original session; cannot sync for continuation");
      if (session.cli === "pi") {
        if (!existsSync(session.sessionFile)) throw new Error(`Original session file is missing: ${session.sessionFile}; no synchronization was performed`);
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
      if (["starting", "running", "waiting"].includes(state.phase)) {
        if (spec.cli === "codex" && mode === "followUp") throw new Error("Codex followUp while running is not supported; wait for this run to finish");
        await this.request(id, { type: "send", message: prompt, mode });
        return this.get(id);
      }
      if (processAlive(state.workerPid)) {
        await waitUntil("Previous worker release", () => !processAlive(state.workerPid), 15_000);
        state = this.get(id);
      }
      const session = nativeSession(state.session ?? (state.sessionFile && state.sessionId ? { sessionFile: state.sessionFile, sessionId: state.sessionId } : undefined));
      if (!session || session.cli !== (spec.cli ?? "pi")) throw new Error("No resumable original session; will not silently create a new session");
      if (session.cli === "codex" && session.codexHome !== spec.codexHome) throw new Error("Codex native home changed; refusing to resume a different session store");
      return this.start(id, prompt, session);
    };
    if (!spec.workspace) return send();
    return this.workspaces.runAgent(spec.workspace, id, async (ws, notice) => {
      const state = await send(notice);
      if (state.accepted || state.phase === "completed") writeJson(path.join(this.directory(id), "spec.json"), {
        ...spec, workspaceBaseline: { commit: ws.baseCommit, revision: ws.revision },
      });
      return this.get(id);
    }, options, beforeSync);
  }

  async close(id: string): Promise<AgentView> {
    const state = this.get(id);
    if (state.phase === "unreachable") throw new Error(state.error);
    if (processAlive(state.workerPid)) {
      if (!["completed", "failed", "stopped", "stopping"].includes(state.phase)) await this.request(id, { type: "close" });
      await waitUntil("Subagent shutdown", () => !processAlive(state.workerPid), 30_000);
    }
    return this.get(id);
  }

  async reply(id: string, questionId: string, answer: { value?: string; confirmed?: boolean; cancelled?: boolean }, decision: { actor: "human" | "parent"; reason?: string } = { actor: "human" }): Promise<AgentView> {
    await this.request(id, { type: "reply", id: questionId, ...answer, ...decision });
    return this.get(id);
  }

  reports(now = Date.now()): Report[] {
    const reports: Report[] = [];
    for (const state of this.list()) {
      const folder = path.join(this.directory(state.id), "reports");
      for (const file of jsonFiles(folder)) {
        const report = readJson<Report>(path.join(folder, file))!;
        if (report.parentFile !== this.parentFile) continue;
        if (report.status === "waiting" && !state.questions.some((q) => q.id === report.questionId)) continue;
        reports.push({ ...report, text: shorten(report.text).text });
      }
      if (state.phase === "unreachable") reports.push({
        notificationId: `${state.runId}-unreachable`, agentId: state.id, runId: state.runId, parentFile: this.parentFile,
        status: "failed", time: state.updatedAt, text: "", error: state.error, logFile: state.logFile,
      });
      if (["running", "starting"].includes(state.phase) && now - state.updatedAt >= 15 * 60_000) reports.push({
        notificationId: `${state.runId}-inactive`, agentId: state.id, runId: state.runId, parentFile: this.parentFile,
        status: "stalled", time: state.updatedAt + 15 * 60_000,
        text: "No activity for 15 minutes; the child may still be running. Inspect with list_agents or /agents; do not assume failure or start duplicate work.",
        logFile: state.logFile,
      });
    }
    return reports.sort((a, b) => a.time - b.time);
  }
}
