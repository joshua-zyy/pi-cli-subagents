import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { control } from "./control.js";
import { directories, jsonFiles, processAlive, readJson, shorten, waitUntil, writeJson } from "./storage.js";
import type { AgentSpec, AgentState, AgentView, Control, Delivery, Endpoint, Launch, Report, Role, SessionHandle, StartRequest } from "./types.js";

const workerFile = fileURLToPath(new URL("./worker.js", import.meta.url));
const idPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

export class AgentManager {
  readonly root: string;
  readonly parentFile: string;
  constructor(parentFile: string, private readonly launch: Launch) {
    this.parentFile = path.resolve(parentFile);
    this.root = `${this.parentFile}.subagents`;
  }

  private directory(id: string): string {
    if (!idPattern.test(id)) throw new Error("Invalid agent id");
    return path.join(this.root, id);
  }
  private spec(id: string): AgentSpec {
    const spec = readJson<AgentSpec>(path.join(this.directory(id), "spec.json"));
    if (!spec || spec.version !== 1 || spec.parentFile !== this.parentFile || spec.id !== id) throw new Error("This subagent does not belong to the current parent session, or its record is missing");
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
    const request = readJson<StartRequest>(path.join(dir, "runs", state.runId, "request.json"));
    const task = request?.message ? request.message.replace(/\s+/g, " ").trim().slice(0, 200) : undefined;
    return { ...state, role: spec.roleName, cwd: spec.cwd, ...(task ? { task } : {}), ...(report ? shorten(report.text) : {}) };
  }
  list(): AgentView[] { return directories(this.root).filter((id) => idPattern.test(id)).map((id) => this.get(id)); }

  /** Return only this parent's validated run logs, ordered by request creation time. */
  eventLogs(id: string): string[] {
    this.spec(id);
    const root = path.join(this.directory(id), "runs");
    return directories(root).filter(runId => idPattern.test(runId)).map(runId => {
      const folder = path.join(root, runId);
      const request = path.join(folder, "request.json");
      return { file: path.join(folder, "events.jsonl"), time: statSync(request).mtimeMs };
    }).sort((a, b) => a.time - b.time || a.file.localeCompare(b.file)).map(run => run.file);
  }

  async spawn(roleName: string, role: Role, cwd: string, message: string): Promise<AgentView> {
    if (!message.trim()) throw new Error("Task must not be empty");
    cwd = path.resolve(cwd);
    if (!statSync(cwd).isDirectory()) throw new Error("cwd must be an existing directory");
    const id = randomUUID(), dir = this.directory(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const spec: AgentSpec = { version: 1, id, parentFile: this.parentFile, cwd, roleName, role, launch: this.launch, createdAt: Date.now() };
    writeJson(path.join(dir, "spec.json"), spec);
    return this.start(id, message);
  }

  private async start(id: string, message: string, session?: SessionHandle): Promise<AgentView> {
    const dir = this.directory(id);
    if (existsSync(path.join(dir, "owner.lock"))) throw new Error("The previous worker still owns this session or a stale lock remains. Inspect it before resuming; concurrent owners are not allowed.");
    if (session && !existsSync(session.sessionFile)) throw new Error(`Original session file is missing: ${session.sessionFile}; will not silently create a new session.`);
    const runId = randomUUID(), runDir = path.join(dir, "runs", runId);
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const initial: StartRequest = { runId, message, session };
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

  async send(id: string, message: string, mode: Delivery = "steer"): Promise<AgentView> {
    if (!message.trim()) throw new Error("Message must not be empty");
    let state = this.get(id);
    if (state.phase === "unreachable") throw new Error(state.error);
    if (["starting", "running", "waiting"].includes(state.phase)) {
      await this.request(id, { type: "send", message, mode });
      return this.get(id);
    }
    if (processAlive(state.workerPid)) {
      await waitUntil("Previous worker release", () => !processAlive(state.workerPid), 15_000);
      state = this.get(id);
    }
    if (!state.sessionFile || !state.sessionId) throw new Error("No resumable original session; will not silently create a new session");
    return this.start(id, message, { sessionFile: state.sessionFile, sessionId: state.sessionId });
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

  async reply(id: string, questionId: string, answer: { value?: string; confirmed?: boolean; cancelled?: boolean }): Promise<AgentView> {
    await this.request(id, { type: "reply", id: questionId, ...answer });
    return this.get(id);
  }

  reports(): Report[] {
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
    }
    return reports.sort((a, b) => a.time - b.time);
  }
}
