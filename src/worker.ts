import { createServer, type Server } from "node:http";
import { openSync, closeSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { PiProcess, type WireRecord } from "./pi-process.js";
import { readJson, writeJson } from "./storage.js";
import type { AgentSpec, AgentState, Control, Question, Report, StartRequest } from "./types.js";

async function run(dir: string, runId: string): Promise<void> {
  const runDir = path.join(dir, "runs", runId);
  const spec = readJson<AgentSpec>(path.join(dir, "spec.json"))!;
  const start = readJson<StartRequest>(path.join(runDir, "request.json"))!;
  if (!spec || spec.version !== 1 || start?.runId !== runId) throw new Error("无效的启动记录");
  const lockFile = path.join(dir, "owner.lock");
  const lock = openSync(lockFile, "wx", 0o600);
  writeFileSync(lock, JSON.stringify({ pid: process.pid, runId }));
  const state: AgentState = {
    id: spec.id, runId, phase: "starting", workerPid: process.pid,
    updatedAt: Date.now(), accepted: false, questions: [], logFile: path.join(runDir, "events.jsonl"),
  };
  const save = () => { state.updatedAt = Date.now(); writeJson(path.join(dir, "state.json"), state); };
  let rpc: PiProcess | undefined, server: Server | undefined, ending = false;
  let assistant: WireRecord | undefined;
  let commandQueue = Promise.resolve();
  const timers = new Set<NodeJS.Timeout>();
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });

  function report(status: Report["status"], text: string, error?: string, questionId?: string): void {
    const notificationId = questionId ? `${runId}-waiting-${randomUUID()}` : `${runId}-result`;
    const file = path.join(dir, "reports", `${notificationId}.json`);
    const record: Report = {
      notificationId, agentId: spec.id, runId, parentFile: spec.parentFile, status, time: Date.now(),
      text, error, questionId, logFile: state.logFile,
      ...(questionId ? {} : { resultFile: file }),
    };
    writeJson(file, record);
    if (!questionId) state.resultFile = file;
  }

  async function finish(status: "completed" | "failed" | "stopped", error?: string, stop = false): Promise<void> {
    if (ending) return;
    ending = true;
    state.phase = "stopping"; save();
    for (const timer of timers) clearTimeout(timer);
    try {
      if (rpc) {
        if (stop) {
          for (const question of state.questions) {
            try { await rpc.reply({ id: question.id, cancelled: true }); } catch { /* stop() still reaps this CLI tree */ }
          }
        }
        const result = await (stop ? rpc.stop() : rpc.end());
        state.exitCode = result.exit.code; state.forced = result.forced;
        if (status === "completed" && (result.exit.code !== 0 || result.forced)) {
          status = "failed"; error = "回合结束，但子 Pi 未正常退出；请检查日志。";
        }
      }
      const text = Array.isArray(assistant?.content) ? assistant.content.filter((part: WireRecord) => part.type === "text").map((part: WireRecord) => part.text).join("") : "";
      state.phase = status; state.error = error; state.questions = [];
      report(status, text, error); save();
    } finally {
      if (server?.listening) server.close(() => resolveFinished());
      else resolveFinished();
    }
  }

  function event(record: WireRecord): void {
    if (ending) return;
    if (record.type === "message_end" && typeof record.message === "object" && record.message?.role === "assistant") assistant = record.message;
    if (record.type === "agent_start" || record.type === "tool_execution_start" || record.type === "tool_execution_end") {
      state.lastActivity = record.type === "agent_start" ? "agent_start" : `${record.type}: ${record.toolName}`;
      state.phase = state.questions.length ? "waiting" : "running"; save();
    }
    if (record.type === "extension_ui_request" &&
      (record.method === "select" || record.method === "confirm" || record.method === "input" || record.method === "editor")) {
      const question: Question = {
        id: String(record.id), method: record.method, title: String(record.title ?? "子代理等待处理"),
        message: typeof record.message === "string" ? record.message : undefined,
        options: record.options, placeholder: record.placeholder, prefill: record.prefill,
        ...(typeof record.timeout === "number" ? { expiresAt: Date.now() + record.timeout } : {}),
      };
      report("waiting", `${question.title}\n${question.message ?? ""}`, undefined, question.id);
      state.questions.push(question); state.phase = "waiting"; save();
      if (question.expiresAt !== undefined) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          state.questions = state.questions.filter((q) => q !== question);
          if (!ending) { state.phase = state.questions.length ? "waiting" : state.accepted ? "running" : "starting"; save(); }
        }, Math.max(0, question.expiresAt - Date.now()));
        timers.add(timer);
      }
    }
    if (record.type === "agent_settled") {
      const reason = assistant?.stopReason;
      void finish(reason === "stop" ? "completed" : reason === "aborted" ? "stopped" : "failed",
        reason === "stop" || reason === "aborted" ? undefined : String(assistant?.errorMessage ?? `未正常完成：${reason ?? "缺少最终消息"}`));
    }
  }

  async function dispatch(input: Control): Promise<AgentState> {
    if (input.type === "status") return state;
    if (input.type === "close") { void finish("stopped", "主 agent 请求关闭", true); return state; }
    if (ending || !rpc) throw new Error("本条未受理：执行端正在启动或收尾，请先查看状态。");
    if (input.type === "send") {
      if (!state.accepted) throw new Error("初始任务尚未受理，请先处理启动交互。");
      if (state.questions.length) throw new Error("子代理等待用户处理；使用 /agent-reply，不要将消息当作审批答复。");
      if (typeof input.message !== "string" || !input.message.trim() || !["steer", "followUp"].includes(input.mode)) throw new Error("无效消息或发送模式");
      await rpc.request({ type: "prompt", message: input.message, streamingBehavior: input.mode });
    } else if (input.type === "reply") {
      const q = state.questions.find((q) => q.id === input.id);
      if (!q) throw new Error("交互请求已结束或不存在");
      if (!input.cancelled) {
        if (q.method === "confirm" ? typeof input.confirmed !== "boolean" : typeof input.value !== "string") throw new Error("答复类型不匹配");
        if (q.method === "select" && !q.options?.includes(input.value!)) throw new Error("选项不匹配");
      }
      await rpc.reply({ id: q.id, value: input.value, confirmed: input.confirmed, cancelled: input.cancelled });
      state.questions = state.questions.filter((item) => item !== q);
      if (!ending) { state.phase = state.questions.length ? "waiting" : state.accepted ? "running" : "starting"; save(); }
    } else throw new Error("未知控制操作");
    return state;
  }

  try {
    save();
    const token = randomBytes(32).toString("hex");
    server = createServer(async (req, res) => {
      res.setHeader("Content-Type", "application/json"); res.setHeader("Connection", "close");
      if (req.method !== "POST" || req.url !== "/" || req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(403).end(JSON.stringify({ error: "forbidden" })); return;
      }
      try {
        let body = "";
        for await (const chunk of req) { body += chunk; if (body.length > 1024 * 1024) throw new Error("控制消息过大"); }
        const input = JSON.parse(body) as Control;
        const operation = commandQueue.then(() => dispatch(input));
        commandQueue = operation.then(() => {}, () => {});
        const result = await operation;
        res.end(JSON.stringify(result));
      } catch (error) { res.writeHead(400).end(JSON.stringify({ error: (error as Error).message })); }
    });
    server.requestTimeout = 40_000;
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("没有本地控制地址");
    writeJson(path.join(dir, "endpoint.json"), { port: address.port, token, runId });
    const sessions = path.join(dir, "sessions"); mkdirSync(sessions, { recursive: true, mode: 0o700 });
    const args = ["--mode", "rpc", "--session-dir", sessions, "--append-system-prompt", `# Delegated role: ${spec.roleName}\n${spec.role.instructions}`];
    if (start.session) args.push("--session", start.session.sessionFile);
    else args.push("--name", `${spec.roleName}:${spec.id}`);
    if (spec.role.provider) args.push("--provider", spec.role.provider);
    if (spec.role.model) args.push("--model", spec.role.model);
    if (spec.role.thinking) args.push("--thinking", spec.role.thinking);
    rpc = new PiProcess(spec.launch, args, spec.cwd, state.logFile, event);
    state.cliPid = rpc.child.pid; save();
    rpc.closed.then((exit) => {
      if (!ending) void finish("failed", `子 Pi 未到 agent_settled 即退出 (${exit.code ?? exit.signal})`);
    });
    const initial = await rpc.request({ type: "get_state" });
    if (typeof initial.sessionId !== "string" || typeof initial.sessionFile !== "string") throw new Error("Pi 未提供持久会话句柄");
    if (start.session && (initial.sessionId !== start.session.sessionId || path.resolve(initial.sessionFile) !== path.resolve(start.session.sessionFile))) throw new Error("恢复返回了不同会话，拒绝继续执行");
    state.sessionId = initial.sessionId; state.sessionFile = initial.sessionFile; save();
    if (!ending) {
      await rpc.request({ type: "prompt", message: start.message });
      state.accepted = true; if (!ending && !state.questions.length) state.phase = "running"; save();
    }
    await finished;
  } catch (error) {
    await finish("failed", (error as Error).message, true);
    await finished;
  } finally {
    for (const timer of timers) clearTimeout(timer);
    server?.close();
    closeSync(lock); unlinkSync(lockFile);
  }
}

const dir = path.resolve(process.argv[2]);
const runId = process.argv[3];
try { await run(dir, runId); }
catch (error) {
  writeJson(path.join(dir, "runs", runId, "error.json"), { error: (error as Error).message });
  process.exitCode = 1;
}
