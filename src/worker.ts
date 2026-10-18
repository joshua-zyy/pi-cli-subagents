import { createServer, type Server } from "node:http";
import { openSync, closeSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { PiAdapter } from "./pi-adapter.js";
import { CodexAdapter } from "./codex-adapter.js";
import { validateQuestionAnswers } from "./codex-question.js";
import { ClaudeAdapter, ClaudeCapabilityError } from "./claude-adapter.js";
import { claudeQuestionAnswers } from "./claude-question.js";
import { type CliAdapter, type AdapterEvent } from "./cli-adapter.js";
import { readJson, writeJson } from "./storage.js";
import { pruneRunLogs, LOG_BUDGET_BYTES } from "./log-writer.js";
import type { AgentSpec, AgentState, Control, ControlResult, OperationReceipt, Question, Report, StartRequest } from "./types.js";

/**
 * A step label repeats while its step lasts: repeated block starts for one tool, tool_progress
 * heartbeats, and Codex's started/completed pairs all name the step already on screen. Only a
 * change is durable, but state.json also carries the liveness timestamp the parent reads to decide
 * an instance stalled (15 minutes), so an unchanged label still refreshes the file this often:
 * far below that window, far above the cadence of the records that repeat one label.
 */
const ACTIVITY_REFRESH_MS = 5_000;

async function run(dir: string, runId: string): Promise<void> {
  let runDir = path.join(dir, "runs", runId);
  const runtimeId = randomUUID();
  const spec = readJson<AgentSpec>(path.join(dir, "spec.json"))!;
  const start = readJson<StartRequest>(path.join(runDir, "request.json"))!;
  if (start?.protocolVersion !== 3) throw new Error("Unsupported worker startup protocol; only v3 is supported. No CLI was launched.");
  if (!spec || ![1, 2, 3].includes(spec.version) || (spec.version === 1 && spec.cli !== undefined && spec.cli !== "pi") || (spec.version === 2 && (spec.cli !== "codex" || !spec.codexHome)) || (spec.version === 3 && (spec.cli !== "claude" || !spec.claudeHome)) || start?.runId !== runId) throw new Error("Invalid startup record");
  const lockFile = path.join(dir, "owner.lock");
  const lock = openSync(lockFile, "wx", 0o600);
  writeFileSync(lock, JSON.stringify({ pid: process.pid, runId, runtimeId }));
  const state: AgentState = {
    id: spec.id, runId, runtimeId, protocolVersion: 3, phase: "starting", workerPid: process.pid, startedAt: start.createdAt ?? Date.now(),
    updatedAt: Date.now(), accepted: false, questions: [], logFile: path.join(runDir, "events.jsonl"),
    ...(start.session ? { session: start.session, sessionId: start.session.sessionId,
      ...("sessionFile" in start.session ? { sessionFile: start.session.sessionFile } : {}) } : {}),
  };
  const save = () => { state.updatedAt = Date.now(); writeJson(path.join(dir, "state.json"), state); };
  // This runtime writes its stderr to the launch run's file for its whole life.
  const launchRunId = runId;
  // A resident runtime writes every run into its own stream; drop the oldest runs' streams first.
  pruneRunLogs(dir, runId);
  let rpc: CliAdapter | undefined, server: Server | undefined, ending = false, released = false, runOpen = true, runCaptured = false;
  let finalText = "";
  const token = randomBytes(32).toString("hex");
  const endpoint = () => {
    const address = server?.address();
    if (!address || typeof address === "string") throw new Error("Local control address is unavailable");
    writeJson(path.join(dir, "endpoint.json"), { port: address.port, token, runId, runtimeId, protocolVersion: 3 });
  };
  const independentQuestions = new Set<string>();
  let unblockStartup: (() => void) | undefined;
  const clearTimers = (all = true) => {
    for (const [id, timer] of timers) if (all || !independentQuestions.has(id)) { clearTimeout(timer); timers.delete(id); }
  };
  const forgetQuestion = (id: string) => {
    independentQuestions.delete(id); clearTimeout(timers.get(id)); timers.delete(id);
    state.questions = state.questions.filter(q => q.id !== id);
  };
  const refreshPhase = () => {
    const blocking = state.questions.some(q => q.isBlocking !== false);
    if (!ending && state.phase !== "unreachable") state.phase = blocking ? "waiting" : runOpen ? state.accepted ? "running" : "starting" : "idle";
    if (!blocking || ending || state.phase === "unreachable") { unblockStartup?.(); unblockStartup = undefined; }
  };
  let commandQueue = Promise.resolve();
  const timers = new Map<string, NodeJS.Timeout>();
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

  type Outcome = { status: "completed" | "failed" | "stopped"; text: string; error?: string };
  function publish(outcome: Outcome): void {
    runOpen = false; runCaptured = false; clearTimers(false); state.lastStatus = outcome.status;
    if (state.phase !== "unreachable") state.error = outcome.error;
    finalText = outcome.text; state.questions = state.questions.filter(q => independentQuestions.has(q.id));
    report(outcome.status, outcome.text, outcome.error);
  }

  // Paseo's close-before-replace and captured-run semantics, adapted to one local worker.
  // Source: getpaseo/paseo 29db2b798..., docs/agent-lifecycle.md / agent-run-state.ts (Apache-2.0).
  async function release(stop: boolean, outcome?: Outcome): Promise<void> {
    if (ending || released) return;
    ending = true; state.phase = "stopping"; clearTimers(); unblockStartup?.(); unblockStartup = undefined;
    if (!outcome && runOpen) outcome = { status: "stopped", text: finalText, error: "Parent requested shutdown" };
    try {
      save();
      if (rpc) {
        if (stop) for (const question of state.questions) {
          try {
            appendFileSync(path.join(runDir, "permissions.jsonl"), `${JSON.stringify({ time: Date.now(), runId,
              questionId: question.id, actor: "controller", decision: "cancelled", delivery: "attempted", reason: "Shutdown cleanup; no action was approved" })}\n`, { mode: 0o600 });
            void rpc.reply({ type: "reply", id: question.id, cancelled: true }).catch(() => {});
          } catch { /* Reap even if cancellation intent could not be recorded. */ }
        }
        const result = await (stop ? rpc.stop() : rpc.end());
        state.exitCode = result.exit.code; state.forced = result.forced;
        if (outcome?.status === "completed" && (result.exit.code !== 0 || result.forced))
          outcome = { ...outcome, status: "failed", error: "The turn ended but child CLI did not exit cleanly; inspect the logs." };
      }
      if (outcome) publish(outcome);
      state.questions = []; independentQuestions.clear(); state.runtimeClosed = true;
      state.phase = "closed"; save(); released = true;
      // Native reaping, not a half-open HTTP client, is the ownership barrier. Allow the
      // current response to flush, then bound connection draining without holding the writer lock.
      server?.close();
      if (server) setTimeout(() => server?.closeAllConnections(), 1_000).unref();
      resolveFinished();
    } catch (error) {
      ending = false; state.phase = "unreachable";
      state.error = `Runtime release is uncertain: ${(error as Error).message}`;
      try { if (outcome) publish({ ...outcome, status: "failed", error: state.error }); }
      finally { save(); }
      throw error; // Keep ownership and the endpoint; never admit a replacement writer.
    }
  }

  function settle(outcome: Outcome, stop = false): void {
    if (!runOpen || ending) return;
    if (rpc?.resident && !stop) { publish(outcome); refreshPhase(); save(); }
    else { runOpen = false; void release(stop, outcome).catch(() => {}); }
  }

  function event(record: AdapterEvent): void {
    if (ending || (record.runId !== undefined && record.runId !== runId)) return;
    if (record.type === "uncertain") { state.phase = "unreachable"; state.error = record.error; save(); }
    if (record.type === "activity") {
      const label = state.lastActivity, phase = state.phase;
      state.lastActivity = record.detail;
      refreshPhase();
      if (state.lastActivity !== label || state.phase !== phase || Date.now() - state.updatedAt >= ACTIVITY_REFRESH_MS) save();
    }
    if (record.type === "question") {
      const question: Question = record.question;
      if (record.runtimeScoped || record.runId === undefined) independentQuestions.add(question.id);
      report("waiting", `${question.title}\n${question.message ?? ""}`, undefined, question.id);
      state.questions.push(question); refreshPhase(); save();
      if (question.expiresAt !== undefined) {
        const timer = setTimeout(() => {
          forgetQuestion(question.id);
          if (!ending) { refreshPhase(); save(); }
        }, Math.max(0, question.expiresAt - Date.now()));
        clearTimeout(timers.get(question.id)); timers.set(question.id, timer);
      }
    }
    if (record.type === "resolved") {
      forgetQuestion(record.id);
      refreshPhase(); save();
    }
    if (record.type === "settled") {
      settle(record, record.stop);
    }
  }

  async function dispatch(input: Control): Promise<ControlResult> {
    let receipt: OperationReceipt | undefined;
    if (input.type === "status") return state;
    if (input.type === "close") {
      if (input.preserveAccepted && state.phase !== "unreachable" && runOpen && state.accepted) throw new Error("A turn is in flight; interrupt first, then stop");
      if (input.onlyIdle && (state.phase !== "idle" || runOpen || state.questions.length)) throw new Error("Runtime is no longer idle; it was not closed");
      const captured = runId;
      await release(true);
      if (!released || !state.runtimeClosed) throw new Error("Runtime release is still pending; shutdown is not confirmed");
      return { ...state, receipt: { operation: "stop", status: "released", runId: captured, runtimeId } };
    }
    if (ending || !rpc) throw new Error("Not accepted: worker is starting or shutting down; inspect its state first.");
    if (state.phase === "unreachable") throw new Error("Runtime execution is uncertain; release it before any new work");
    if (input.type === "start") {
      if (!rpc.resident || state.phase !== "idle" || runOpen || state.questions.length) throw new Error("Runtime is not idle; new work was not accepted");
      if (typeof input.message !== "string" || !input.message.trim()) throw new Error("Task must not be empty");
      const next = randomUUID(), nextRunDir = path.join(dir, "runs", next), logFile = path.join(nextRunDir, "events.jsonl");
      const request: StartRequest = { protocolVersion: 3, runId: next, message: input.message, createdAt: Math.max(Date.now(), (state.startedAt ?? 0) + 1), session: state.session, logFile };
      writeJson(path.join(nextRunDir, "request.json"), request);
      // Each run writes its own raw stream, so one resident runtime cannot grow a single file.
      rpc.rotateLog(logFile);
      pruneRunLogs(dir, next, LOG_BUDGET_BYTES, launchRunId);
      runId = next; runDir = nextRunDir; runOpen = true; finalText = ""; clearTimers();
      state.runId = next; state.startedAt = request.createdAt; state.accepted = false; state.phase = "starting"; state.logFile = logFile;
      delete state.error; delete state.resultFile; delete state.lastStatus; delete state.lastActivity;
      save(); endpoint();
      try {
        runCaptured = true; await rpc.start(input.message, runId); state.accepted = true; refreshPhase(); save();
        receipt = { operation: "start", status: "accepted", runId, runtimeId };
      }
      catch (error) { await release(true, { status: "failed", text: finalText, error: (error as Error).message }); throw error; }
    } else if (input.type === "interrupt") {
      if (!runOpen || !runCaptured) return { ...state, receipt: { operation: "interrupt", status: "not_running", runId, runtimeId } };
      const captured = runId;
      try {
        await rpc.interrupt();
        if (runId === captured && runOpen) settle({ status: "stopped", text: finalText, error: "Parent interrupted the current turn" });
        // A natural terminal may beat the interrupt. Acknowledge settlement, not
        // a claim that interruption caused the outcome or released the runtime.
        receipt = { operation: "interrupt", status: "settled", runId: captured, runtimeId };
      } catch (error) {
        if (error instanceof ClaudeCapabilityError) throw error;
        state.phase = "unreachable"; state.error = `Interrupt outcome uncertain: ${(error as Error).message}`; save(); throw error;
      }
    } else if (input.type === "send") {
      if (!runOpen) throw new Error("No active run; use start for a new assignment");
      if (!state.accepted) throw new Error("Initial task has not been accepted; resolve any startup interaction first.");
      if (state.questions.some(q => q.isBlocking !== false)) throw new Error("The child has an unresolved interaction. Use subagent_reply or /agents (i details, r reply); a message is not an approval.");
      if (typeof input.message !== "string" || !input.message.trim() || !["steer", "followUp"].includes(input.mode)) throw new Error("Invalid message or delivery mode");
      const captured = runId;
      await rpc.send(input.message, input.mode);
      // Adapter success acknowledges this native request. In Pi, prompt with
      // streamingBehavior can be handled/started at the settle boundary; the mode
      // name alone is not queue or applied evidence (Pi 1.1.0 AgentSession.prompt).
      receipt = { operation: "send", status: "accepted", runId: captured, runtimeId };
    } else if (input.type === "reply") {
      const q = state.questions.find((q) => q.id === input.id);
      if (!q || (q.expiresAt !== undefined && q.expiresAt <= Date.now())) throw new Error("The interaction has ended or does not exist");
      const choices = Number(input.cancelled === true) + Number(typeof input.confirmed === "boolean") + Number(typeof input.value === "string") + Number(input.answers !== undefined);
      if (choices !== 1) throw new Error("Provide exactly one response: confirmed, value, answers, or cancelled");
      const form = q.kind === "question" && q.method === "form" && q.fields;
      const textAnswer = q.parentPolicy?.text === true && q.humanOnly !== true &&
        (q.method === "input" || q.method === "editor" || q.kind === "question" && q.method === "select");
      if (!input.cancelled) {
        if (form) {
          input.answers = validateQuestionAnswers(form, input.answers);
          if (spec.cli === "claude") claudeQuestionAnswers(form, input.answers);
        } else {
          if (input.answers !== undefined || (q.method === "confirm" ? typeof input.confirmed !== "boolean" : typeof input.value !== "string")) throw new Error("Response type does not match the question");
          if (q.method === "select" && !textAnswer && !q.options?.includes(input.value!)) throw new Error("Response is not one of the available options");
        }
      }
      if (input.actor === "parent" && (typeof input.reason !== "string" || !input.reason.trim())) throw new Error("A parent decision requires a reason");
      if (input.actor !== undefined && input.actor !== "parent" && input.actor !== "human") throw new Error("Unknown decision actor");
      if (input.actor === "parent" && !input.cancelled) {
        // The policy describes supported responses, not proof of user authorization. Keep
        // native human-only restrictions and refusal-only defaults; the parent judges the authorized scope.
        const refusal = q.method === "confirm" && input.confirmed === false;
        const permitted = form ? q.parentPolicy?.answers === true && q.humanOnly !== true :
          q.method === "confirm" ? q.parentPolicy?.confirm === true : textAnswer || q.parentPolicy?.values?.includes(input.value!) === true;
        if (!refusal && !permitted) throw new Error("This request requires human approval; the parent agent may only refuse it, not approve it");
      }
      // Record intent before sending: a failed log write must not silently approve an action.
      appendFileSync(path.join(runDir, "permissions.jsonl"), `${JSON.stringify({ time: Date.now(), runId, questionId: q.id,
        actor: input.actor ?? "human", decision: input.cancelled ? "cancelled" : q.method === "confirm" ? input.confirmed ? "approved" : "denied" : "answered",
        delivery: "attempted", ...(q.kind ? { kind: q.kind } : {}), ...(input.reason ? { reason: input.reason.slice(0, 2000) } : {}),
        ...(q.method === "select" && q.options?.includes(input.value!) ? { selectedOption: input.value } : {}),
      })}\n`, { mode: 0o600 });
      await rpc.reply(input);
      forgetQuestion(q.id);
      if (!ending) { refreshPhase(); save(); }
    } else throw new Error("Unknown control operation");
    return { ...state, questions: [...state.questions], ...(receipt ? { receipt } : {}) };
  }

  try {
    save();
    server = createServer(async (req, res) => {
      res.setHeader("Content-Type", "application/json"); res.setHeader("Connection", "close");
      if (req.method !== "POST" || req.url !== "/" || req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(403).end(JSON.stringify({ error: "forbidden" })); return;
      }
      try {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) throw new Error("Control message is too large");
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks, bytes).toString("utf8");
        const input = JSON.parse(body) as Control & { protocolVersion?: number; runtimeId?: string; expectedRunId?: string };
        const operation = commandQueue.then(() => {
          if (input.protocolVersion !== 3 || input.runtimeId !== runtimeId || input.expectedRunId !== runId)
            throw new Error("Worker control protocol/runtime/run identity mismatch; inspect before retrying");
          return dispatch(input);
        });
        commandQueue = operation.then(() => {}, () => {});
        const result = await operation;
        res.end(JSON.stringify(result));
      } catch (error) { res.writeHead(400).end(JSON.stringify({ error: `Subagent ${spec.id}, run ${runId}, runtime ${runtimeId}: ${(error as Error).message}` })); }
    });
    server.requestTimeout = 40_000;
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", resolve); });
    endpoint();
    const session = start.session;
    rpc = (spec.cli ?? "pi") === "codex"
      ? new CodexAdapter({ spec, session, logFile: state.logFile, onEvent: event })
      : spec.cli === "claude" ? new ClaudeAdapter({ spec, session, logFile: state.logFile, onEvent: event })
      : new PiAdapter({ spec, session, logFile: state.logFile, onEvent: event });
    state.cliPid = rpc.pid; save();
    rpc.closed.then((exit) => {
      if (ending) return;
      const error = `Child CLI exited unexpectedly (${exit.code ?? exit.signal}); previous run results are unchanged`;
      if (runOpen) settle({ status: "failed", text: finalText, error }, true);
      else {
        state.error = error;
        writeJson(path.join(dir, "reports", `${runtimeId}-exited.json`), {
          notificationId: `${runtimeId}-exited`, agentId: spec.id, runId, parentFile: spec.parentFile,
          status: "failed", time: Date.now(), text: "Runtime exited between assignments; read the original run result by runId.", error, logFile: state.logFile,
        } satisfies Report);
        void release(false).catch(() => {});
      }
    });
    const initial = await rpc.ready();
    state.session = initial; state.sessionId = initial.sessionId;
    if (initial.cli === "pi") state.sessionFile = initial.sessionFile;
    save();
    // Runtime-level startup dialogs may outlive ready(). Do not occupy the control
    // queue while waiting: parent replies must be able to unblock the original task.
    while (!ending && state.phase !== "unreachable" && state.questions.some(q => q.isBlocking !== false))
      await new Promise<void>(resolve => { unblockStartup = resolve; });
    if (!ending && state.phase !== "unreachable") {
      runCaptured = true;
      await rpc.start(start.message, runId);
      state.accepted = true; refreshPhase(); if (!released) save();
    }
    await finished;
  } catch (error) {
    await release(true, { status: "failed", text: finalText, error: (error as Error).message }).catch(() => {});
    await finished;
  } finally {
    clearTimers();
    server?.close();
    closeSync(lock);
    if (released) unlinkSync(lockFile);
  }
}

const dir = path.resolve(process.argv[2]);
const runId = process.argv[3];
try { await run(dir, runId); }
catch (error) {
  writeJson(path.join(dir, "runs", runId, "error.json"), { error: (error as Error).message });
  process.exitCode = 1;
}
