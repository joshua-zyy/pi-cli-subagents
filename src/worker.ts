import { createServer, type Server } from "node:http";
import { openSync, closeSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { PiAdapter } from "./pi-adapter.js";
import { CodexAdapter } from "./codex-adapter.js";
import { nativeSession, type CliAdapter, type AdapterEvent } from "./cli-adapter.js";
import { readJson, writeJson } from "./storage.js";
import type { AgentSpec, AgentState, Control, Question, Report, StartRequest } from "./types.js";

async function run(dir: string, runId: string): Promise<void> {
  const runDir = path.join(dir, "runs", runId);
  const spec = readJson<AgentSpec>(path.join(dir, "spec.json"))!;
  const start = readJson<StartRequest>(path.join(runDir, "request.json"))!;
  if (!spec || (spec.version !== 1 && spec.version !== 2) || (spec.version === 2 && (spec.cli !== "codex" || !spec.codexHome)) || start?.runId !== runId) throw new Error("Invalid startup record");
  const lockFile = path.join(dir, "owner.lock");
  const lock = openSync(lockFile, "wx", 0o600);
  writeFileSync(lock, JSON.stringify({ pid: process.pid, runId }));
  const state: AgentState = {
    id: spec.id, runId, phase: "starting", workerPid: process.pid, startedAt: Date.now(),
    updatedAt: Date.now(), accepted: false, questions: [], logFile: path.join(runDir, "events.jsonl"),
    ...(start.session ? { session: nativeSession(start.session), sessionId: start.session.sessionId,
      ...("sessionFile" in start.session ? { sessionFile: start.session.sessionFile } : {}) } : {}),
  };
  const save = () => { state.updatedAt = Date.now(); writeJson(path.join(dir, "state.json"), state); };
  let rpc: CliAdapter | undefined, server: Server | undefined, ending = false;
  let finalText = "";
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
            try { await rpc.reply({ type: "reply", id: question.id, cancelled: true }); } catch { /* stop() still reaps this CLI tree */ }
          }
        }
        const result = await (stop ? rpc.stop() : rpc.end());
        state.exitCode = result.exit.code; state.forced = result.forced;
        if (status === "completed" && (result.exit.code !== 0 || result.forced)) {
          status = "failed"; error = "The turn ended but child CLI did not exit cleanly; inspect the logs.";
        }
      }
      state.phase = status; state.error = error; state.questions = [];
      report(status, finalText, error); save();
    } finally {
      if (server?.listening) server.close(() => resolveFinished());
      else resolveFinished();
    }
  }

  function event(record: AdapterEvent): void {
    if (ending) return;
    if (record.type === "activity") {
      state.lastActivity = record.detail;
      state.phase = state.questions.length ? "waiting" : "running"; save();
    }
    if (record.type === "question") {
      const question: Question = record.question;
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
    if (record.type === "resolved") {
      state.questions = state.questions.filter(q => q.id !== record.id);
      state.phase = state.questions.length ? "waiting" : state.accepted ? "running" : "starting"; save();
    }
    if (record.type === "settled") {
      finalText = record.text;
      void finish(record.status, record.error, record.stop);
    }
  }

  async function dispatch(input: Control): Promise<AgentState> {
    if (input.type === "status") return state;
    if (input.type === "close") { void finish("stopped", "Parent requested shutdown", true); return state; }
    if (ending || !rpc) throw new Error("Not accepted: worker is starting or shutting down; inspect its state first.");
    if (input.type === "send") {
      if (!state.accepted) throw new Error("Initial task has not been accepted; resolve any startup interaction first.");
      if (state.questions.length) throw new Error("The child has an unresolved interaction. Use respond_to_permission or /agent-reply; a message is not an approval.");
      if (typeof input.message !== "string" || !input.message.trim() || !["steer", "followUp"].includes(input.mode)) throw new Error("Invalid message or delivery mode");
      await rpc.send(input.message, input.mode);
    } else if (input.type === "reply") {
      const q = state.questions.find((q) => q.id === input.id);
      if (!q || (q.expiresAt !== undefined && q.expiresAt <= Date.now())) throw new Error("The interaction has ended or does not exist");
      const choices = Number(input.cancelled === true) + Number(typeof input.confirmed === "boolean") + Number(typeof input.value === "string");
      if (choices !== 1) throw new Error("Provide exactly one response: confirmed, value, or cancelled");
      if (!input.cancelled) {
        if (q.method === "confirm" ? typeof input.confirmed !== "boolean" : typeof input.value !== "string") throw new Error("Response type does not match the question");
        if (q.method === "select" && !q.options?.includes(input.value!)) throw new Error("Response is not one of the available options");
      }
      if (input.actor === "parent" && (typeof input.reason !== "string" || !input.reason.trim())) throw new Error("A parent decision requires a reason");
      if (input.actor !== undefined && input.actor !== "parent" && input.actor !== "human") throw new Error("Unknown decision actor");
      // Record intent before sending: a failed log write must not silently approve an action.
      appendFileSync(path.join(runDir, "permissions.jsonl"), `${JSON.stringify({ time: Date.now(), runId, questionId: q.id,
        actor: input.actor ?? "human", decision: input.cancelled ? "cancelled" : q.method === "confirm" ? input.confirmed ? "approved" : "denied" : "answered",
        delivery: "attempted", ...(input.reason ? { reason: input.reason.slice(0, 2000) } : {}),
        ...(q.method === "select" && input.value !== undefined ? { selectedOption: input.value } : {}),
      })}\n`, { mode: 0o600 });
      await rpc.reply(input);
      state.questions = state.questions.filter((item) => item !== q);
      if (!ending) { state.phase = state.questions.length ? "waiting" : state.accepted ? "running" : "starting"; save(); }
    } else throw new Error("Unknown control operation");
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
        for await (const chunk of req) { body += chunk; if (body.length > 1024 * 1024) throw new Error("Control message is too large"); }
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
    if (!address || typeof address === "string") throw new Error("Local control address is unavailable");
    writeJson(path.join(dir, "endpoint.json"), { port: address.port, token, runId });
    const session = nativeSession(start.session);
    rpc = (spec.cli ?? "pi") === "codex"
      ? new CodexAdapter({ spec, session, logFile: state.logFile, onEvent: event })
      : new PiAdapter({ spec, session, logFile: state.logFile, onEvent: event });
    state.cliPid = rpc.pid; save();
    rpc.closed.then((exit) => {
      if (!ending) void finish("failed", `Child CLI exited before a terminal event (${exit.code ?? exit.signal})`);
    });
    const initial = await rpc.ready();
    state.session = initial; state.sessionId = initial.sessionId;
    if (initial.cli === "pi") state.sessionFile = initial.sessionFile;
    save();
    if (!ending) {
      await rpc.start(start.message);
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
