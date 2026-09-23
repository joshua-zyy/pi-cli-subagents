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
    if (!idPattern.test(id)) throw new Error("无效 agent id");
    return path.join(this.root, id);
  }
  private spec(id: string): AgentSpec {
    const spec = readJson<AgentSpec>(path.join(this.directory(id), "spec.json"));
    if (!spec || spec.version !== 1 || spec.parentFile !== this.parentFile || spec.id !== id) throw new Error("该子代理不属于当前主会话，或记录不存在");
    return spec;
  }
  get(id: string): AgentView {
    const spec = this.spec(id), dir = this.directory(id);
    let state = readJson<AgentState>(path.join(dir, "state.json"));
    if (!state) throw new Error(`子代理 ${id} 尚未建立运行状态；检查 ${dir}`);
    if (["starting", "running", "waiting", "stopping"].includes(state.phase) && !processAlive(state.workerPid)) {
      state = { ...state, phase: "unreachable", error: "后台执行端已退出，任务状态不确定；禁止另起实例重复执行。检查日志与 owner.lock。" };
    }
    const report = state.resultFile ? readJson<Report>(state.resultFile) : undefined;
    return { ...state, role: spec.roleName, cwd: spec.cwd, ...(report ? shorten(report.text) : {}) };
  }
  list(): AgentView[] { return directories(this.root).filter((id) => idPattern.test(id)).map((id) => this.get(id)); }

  async spawn(roleName: string, role: Role, cwd: string, message: string): Promise<AgentView> {
    if (!message.trim()) throw new Error("任务不能为空");
    cwd = path.resolve(cwd);
    if (!statSync(cwd).isDirectory()) throw new Error("cwd 必须是现有目录");
    const id = randomUUID(), dir = this.directory(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const spec: AgentSpec = { version: 1, id, parentFile: this.parentFile, cwd, roleName, role, launch: this.launch, createdAt: Date.now() };
    writeJson(path.join(dir, "spec.json"), spec);
    return this.start(id, message);
  }

  private async start(id: string, message: string, session?: SessionHandle): Promise<AgentView> {
    const dir = this.directory(id);
    if (existsSync(path.join(dir, "owner.lock"))) throw new Error("原执行端尚未释放或存在旧锁；先检查状态，不能并发恢复同一 session。");
    if (session && !existsSync(session.sessionFile)) throw new Error(`原 session 文件丢失：${session.sessionFile}；不会静默新建。`);
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
      return await waitUntil(`子代理 ${id} 启动`, () => {
        const failure = readJson<{ error: string }>(path.join(runDir, "error.json"));
        if (failure) throw new Error(failure.error);
        const state = readJson<AgentState>(path.join(dir, "state.json"));
        if (!state || state.runId !== runId) return undefined;
        const view = this.get(id);
        if (view.phase === "unreachable") throw new Error(view.error);
        return view.accepted || ["waiting", "failed", "stopped", "completed"].includes(view.phase) ? view : undefined;
      }, 45_000);
    } catch (error) {
      throw new Error(`子代理 ${id}: ${(error as Error).message}；记录保留于 ${dir}`);
    }
  }

  private async request(id: string, input: Control): Promise<void> {
    const state = this.get(id);
    if (!processAlive(state.workerPid)) throw new Error("执行端已退出；请查看最终状态");
    const endpoint = readJson<Endpoint>(path.join(this.directory(id), "endpoint.json"));
    if (!endpoint || endpoint.runId !== state.runId) throw new Error("执行端尚未就绪，或连接记录过期");
    await control(endpoint, input);
  }

  async send(id: string, message: string, mode: Delivery = "steer"): Promise<AgentView> {
    if (!message.trim()) throw new Error("消息不能为空");
    let state = this.get(id);
    if (state.phase === "unreachable") throw new Error(state.error);
    if (["starting", "running", "waiting"].includes(state.phase)) {
      await this.request(id, { type: "send", message, mode });
      return this.get(id);
    }
    if (processAlive(state.workerPid)) {
      await waitUntil("上一轮进程释放", () => !processAlive(state.workerPid), 15_000);
      state = this.get(id);
    }
    if (!state.sessionFile || !state.sessionId) throw new Error("没有可恢复的原 session；不会静默新建");
    return this.start(id, message, { sessionFile: state.sessionFile, sessionId: state.sessionId });
  }

  async close(id: string): Promise<AgentView> {
    const state = this.get(id);
    if (state.phase === "unreachable") throw new Error(state.error);
    if (processAlive(state.workerPid)) {
      if (!["completed", "failed", "stopped", "stopping"].includes(state.phase)) await this.request(id, { type: "close" });
      await waitUntil("子代理关闭", () => !processAlive(state.workerPid), 30_000);
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
