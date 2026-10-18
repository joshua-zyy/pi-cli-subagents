import { Type } from "@earendil-works/pi-ai";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { getAgentDir, getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "./manager.js";
import { WorkspaceDecisionRequired, type ResumeOptions } from "./workspace.js";
import { customType as reportType, deliverReports } from "./notifier.js";
import { humanActionType, deliverHumanActions, saveHumanAction } from "./human-actions.js";
import { renderReportMessage, renderHumanActionMessage } from "./ui/report.js";
import { CLI_CHOICES, loadRoles, mergeRoles } from "./roles.js";
import { detectClis, probeCatalog, type ModelCatalog } from "./cli-discovery.js";
import { claudeDefaultValues, probeRoleDefaults, type NativeDefaults } from "./role-defaults.js";
import { addRole, deleteRole, FIELD_LABELS, fieldValue, readScope, roleRows, setField, writeScope, type Scope } from "./role-settings.js";
import { AgentsPanel, paneRows, type PanelAction } from "./ui/panel.js";
import { RoleSettingsPanel, SETTINGS_MAX_ROWS, type RoleSettingsAction, type RoleSettingsCursor } from "./ui/role-settings.js";
import { canMessage, canResume, canSteer, canRelease, canReleaseUncertain, hasFailure, oneLine, viewStatus } from "./ui/format.js";
import { StatusWidget } from "./ui/status.js";
import { TranscriptWindow, WINDOW_MAX_BYTES } from "./transcript-window.js";
import { TranscriptCache, TRANSCRIPT_CACHE_LIMITS, type TranscriptIdentity } from "./ui/transcript-cache.js";
import { ConversationViewer } from "./ui/conversation.js";
import { projectUsage, USAGE_INCOMPLETE, USAGE_TOO_LARGE, USAGE_UNREADABLE, type UsageProjection } from "./usage.js";
import type { AgentView, Delivery, Launch, Question, QuestionAnswers, Role, Thinking } from "./types.js";

export function parentManager(ctx: Pick<ExtensionContext, "sessionManager">, launch: Launch): AgentManager {
  const parentFile = ctx.sessionManager.getSessionFile();
  if (!parentFile) throw new Error("A persistent parent session is required (do not use --no-session) to route and replay child reports.");
  return new AgentManager(parentFile, launch);
}

function visible(state: AgentView, includeText = true) {
  // `task`, `history` and `startedAt` let the parent match an instance to its assignments
  // after its own context is compacted, without reading the child's transcript.
  const { id, cli, role, phase, protocolVersion, runtimeId, lastStatus, receipt, reclaimed, task, history, runCount, runId, sessionId, session, cwd, startedAt, updatedAt, lastActivity, questions, text, truncated, error, logFile } = state;
  return { id, cli, role, phase, protocolVersion, runtimeId, lastStatus, ...(receipt ? { receipt } : {}), ...(reclaimed ? { reclaimed } : {}), runId, sessionId, ...(session?.cli === "codex" ? { threadId: session.threadId } : {}), cwd, updatedAt, lastActivity, questions, ...(includeText ? { text, truncated } : {}), error, logFile, history, runCount,
    ...(state.workspace ? { workspace: state.workspace, workspaceBaseline: state.workspaceBaseline } : {}), ...(task ? { task } : {}), ...(startedAt ? { startedAt } : {}) };
}

/** How many bounded pages one query may walk back; the byte budget check bounds the rest. */
const USAGE_PAGE_LIMIT = 12;

/** Bytes sampled at each end and at two interior quantiles of a run log, so an in-place rewrite is
 * noticed without trusting clocks. The interior probes shrink the undetectable window to a rewrite
 * that happens to avoid four bounded slices; a full-file hash would mean rescanning the log. */
const USAGE_SAMPLE_BYTES = 4096;

/** File identity of one retained run log, as seen at one point in time. */
interface LogState { size: number; ino: number; dev: number; mtimeMs: number; ctimeMs: number; head: string; mid: string; tail: string }

/** One bounded sample of an open run log; the caller decides which slice it read. */
function sampleAt(file: string, offset: number, length: number, buffer: Buffer): string {
  if (length <= 0) return "";
  const handle = openSync(file, "r");
  try { const read = readSync(handle, buffer, 0, length, Math.max(0, offset)); return buffer.subarray(0, read).toString("base64"); }
  finally { closeSync(handle); }
}

/** Interior slices for a log long enough to have a middle that head and tail samples do not cover. */
function interiorProbes(size: number): number[] {
  if (size <= 3 * USAGE_SAMPLE_BYTES) return [];
  const highest = size - 2 * USAGE_SAMPLE_BYTES;
  const probe = (share: number): number => Math.max(USAGE_SAMPLE_BYTES, Math.min(highest, Math.floor(size * share) - USAGE_SAMPLE_BYTES / 2));
  return [probe(0.25), probe(0.75)];
}

/** Identity of every retained run log, or undefined when one of them cannot be sampled as a file. */
function logStates(files: string[]): LogState[] | undefined {
  const states: LogState[] = [];
  const buffer = Buffer.alloc(USAGE_SAMPLE_BYTES);
  for (const file of files) {
    try {
      const stat = statSync(file);
      if (!stat.isFile()) return undefined;
      const length = Math.min(stat.size, USAGE_SAMPLE_BYTES);
      const interior = interiorProbes(stat.size).map(offset => sampleAt(file, offset, USAGE_SAMPLE_BYTES, buffer));
      states.push({ size: stat.size, ino: stat.ino, dev: stat.dev, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
        head: sampleAt(file, 0, length, buffer), mid: interior.join(""), tail: sampleAt(file, stat.size - length, length, buffer) });
    }
    catch { return undefined; }
  }
  return states;
}

/**
 * A log that shrank, moved to another file or was rewritten in place cannot prove one snapshot.
 * Appends are expected while a child runs, so a growing file is fine and only its head must hold;
 * Windows keeps last-write times coarse, so content samples decide an in-place rewrite, not clocks.
 * Undetectable without rescanning the log: a rewrite of the same size that avoids all four slices.
 */
function rewrittenInPlace(before: LogState, after: LogState): boolean {
  if (after.size < before.size) return true;
  if (after.ino !== before.ino || after.dev !== before.dev) return true;
  if (after.head !== before.head) return true;
  // Growth moves the tail and interior windows, so only a same-size file can be compared slice by slice.
  if (after.size !== before.size) return false;
  if (after.tail !== before.tail) return true;
  if (after.mid !== before.mid) return true;
  return after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs;
}

/** Only describe the actual operation receipt, never infer delivery from an old phase/accepted bit. */
function receiptText(state: AgentView): string {
  switch (state.receipt?.status) {
    case "accepted": return "Native input request acknowledged; this is not proof of model consumption or task success.";
    case "queued": return "Input queued by the native CLI; model consumption and execution are not confirmed.";
    case "settled": return "The captured turn has ended; its actual outcome is retained. The runtime was not released.";
    case "released": return "Native processes released; the original session, history and completed results are retained.";
    case "reclaimed": return "Accounting reclaimed for this runtime only: both dimensions no longer count it. No native release was confirmed, the lock and history are untouched, and this instance cannot be continued.";
    case "not_running": return "No captured active turn to interrupt; pending startup is not cancelled. History is retained.";
    default: return "Operation confirmation is unconfirmed. Inspect the instance before retrying; work may already have run.";
  }
}

/** Action-specific requirements supplement the flat provider-compatible object schemas. */
function checkFields(args: Record<string, unknown>, required: string[], optional: string[] = []): void {
  for (const key of Object.keys(args)) {
    if (!required.includes(key) && !optional.includes(key)) throw new Error(`Field ${key} is not allowed for this action`);
  }
  for (const key of required) {
    if (typeof args[key] !== "string" || !(args[key] as string).trim()) throw new Error(`This action requires ${key} as a non-empty string`);
  }
}

const view = (state: AgentView, includeText = true): string => JSON.stringify(visible(state, includeText));
const content = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
const REPORT_GUIDANCE = "Completion and interaction reports return to this parent session automatically. Do not sleep or poll for completion; continue independent work or end this turn to await a report. Do not duplicate the child's assignment. Receiving a report is not verification; read any truncated result with subagent_query result before assessing its claims.";
/**
 * A Pi role that leaves provider/model/thinking unset follows the parent session's current choice
 * instead of Pi's configured default, so switching model mid-session also moves its subagents.
 * Codex and Claude roles are explicit by construction and are never rewritten here.
 */
export function inheritParentModel(role: Role, ctx: Pick<ExtensionContext, "model" | "thinkingLevel">): Role {
  if (role.cli !== undefined && role.cli !== "pi") return role;
  const model = ctx.model;
  return {
    ...role,
    ...(role.provider || !model ? {} : { provider: String(model.provider) }),
    ...(role.model || !model ? {} : { model: model.id }),
    ...(role.thinking || !ctx.thinkingLevel ? {} : { thinking: ctx.thinkingLevel as Thinking }),
  };
}
/** Separate from report receipts: these entries record what the human did, not what a child reported. */
export { humanActionType } from "./human-actions.js";

export default function extension(pi: ExtensionAPI): void {
  // Explicit child marker prevents an auto-discovered copy of this extension from recursively spawning agents.
  if (process.env.PI_CLI_SUBAGENT === "1") return;
  pi.registerMessageRenderer(reportType, renderReportMessage);
  pi.registerMessageRenderer(humanActionType, renderHumanActionMessage);
  const cli = process.argv[1];
  const launch: Launch = { command: process.execPath, args: [cli] };
  let dismissPanel: (() => void) | undefined;
  let sessionEpoch = 0;
  const humanPending = new Set<string>();

  /**
   * The parent coordinates this instance, so a direct human action must not be invisible to it.
   * It is recorded without starting a turn: routine additions should not interrupt sibling work,
   * and the entry is already in context when the child's own report arrives.
   */
  function recordHumanAction(ctx: ExtensionContext, manager: AgentManager, agent: AgentView, action: string, epoch: number): void {
    const text = `[Human → subagent ${agent.id} · ${agent.role}] ${action}\n`
      + (agent.receipt ? `Operation receipt: ${JSON.stringify(agent.receipt)}\n` : "")
      + "The user acted on this instance directly. Re-check your plan for it before integrating or dispatching related work. This does not widen the task's original authorization.";
    try {
      // The plain manager identity survives a Pi context replacement; old ctx/pi do not.
      saveHumanAction(manager, agent.receipt ? { ...agent, runId: agent.receipt.runId } : agent, text);
      if (epoch === sessionEpoch) deliverHumanActions(manager, pi, ctx, humanPending);
    } catch (error) {
      console.error("[pi-cli-subagents] Human action recording/delivery failed:", error);
      if (epoch === sessionEpoch) try {
        if (ctx.sessionManager.getSessionFile() === manager.parentFile)
          ctx.ui.notify(`The parent action receipt is not confirmed: ${(error as Error).message}`, "warning");
      } catch { /* The old UI may already have been invalidated by Pi. */ }
    }
  }

  /** A resolved send can still have failed; both UI paths report the same receipt and phase. */
  function recordHumanInput(ctx: ExtensionContext, manager: AgentManager, agent: AgentView, input: string, action: string, epoch: number): void {
    if (hasFailure(agent)) {
      const error = new Error(`Subagent input failed: ${agent.error ?? "No error details available"}\nInstance: ${agent.id}\nRun: ${agent.runId}\nInspect the instance before retrying; work may already have run.`);
      recordHumanAction(ctx, manager, agent, `Input request failed: ${input}\n${error.message}\n${receiptText(agent)}`, epoch);
      throw error;
    }
    recordHumanAction(ctx, manager, agent, `${action}: ${input}\n${receiptText(agent)}\nObserved ${viewStatus(agent).label}; instance: ${agent.id}; run: ${agent.runId}.`, epoch);
  }

  async function sendAndRecord(ctx: ExtensionContext, manager: AgentManager, id: string, message: string, epoch: number, action: string, options: ResumeOptions = {}): Promise<AgentView> {
    if (epoch !== sessionEpoch) throw new Error("Parent session changed before input request; no input sent.");
    const before = manager.get(id);
    const input = `"${oneLine(message, 400)}"${options.baseline ? ` (workspace baseline: ${options.baseline})` : ""}`;
    let state: AgentView;
    try { state = await manager.send(id, message, "steer", options); }
    catch (error) {
      if (!(error instanceof WorkspaceDecisionRequired)) {
        let observed = before;
        try { observed = manager.get(id); } catch { /* Retain the last known identity. */ }
        recordHumanAction(ctx, manager, observed, `Input request unconfirmed: ${input}\n${(error as Error).message}\nInspect the instance before retrying; work may already have run.`, epoch);
      }
      throw error;
    }
    recordHumanInput(ctx, manager, state, input, action, epoch);
    return state;
  }

  let active: { file: string; ctx: ExtensionContext; manager: AgentManager; pending: Set<string>; timer: NodeJS.Timeout; agents: AgentView[]; widget?: StatusWidget;
    updatePanel?: (agents: AgentView[]) => void } | undefined;
  /** Paged transcript windows for this extension instance; cleared when monitoring stops. */
  const transcriptCache = new TranscriptCache();
  // A query reads through its own cache with its own explicit budget: it must never park, page or
  // invalidate the window a viewer holds, and its retained windows stay bounded like the viewer's.
  const usageCache = new TranscriptCache({ instances: TRANSCRIPT_CACHE_LIMITS.instances,
    entries: TRANSCRIPT_CACHE_LIMITS.entries, bytes: TRANSCRIPT_CACHE_LIMITS.bytes });

  /** The child's own reported usage for one instance, read on demand through its own paged window. */
  async function reportedUsage(manager: AgentManager, id: string, state: AgentView, signal?: AbortSignal): Promise<UsageProjection> {
    const unreadable = { usageComplete: false as const, usageNote: USAGE_UNREADABLE };
    try {
      const files = manager.eventLogs(id);
      const before = logStates(files);
      // A missing run log means the session total cannot be established from what remains, even when
      // the older files read cleanly: never pass off an older run's numbers as the session total.
      if (files.length > 0 && before === undefined) { signal?.throwIfAborted(); return unreadable; }
      const bytes = before?.reduce((sum, state) => sum + state.size, 0);
      const cli = state.cli ?? "pi";
      // Same identity rules as the viewer: only a native id already recorded may be attributed.
      const identity: TranscriptIdentity = { parentFile: manager.parentFile, agentId: id, cli,
        ...(state.session?.cli === "codex" ? { nativeId: state.session.threadId } : state.session?.cli === "claude" ? { nativeId: state.session.sessionId } : {}) };
      const lease = await usageCache.acquire(identity, files, () => new TranscriptWindow(identity.cli, identity.nativeId));
      // A cancelled query must stop starting reads, not merely reject afterwards: the window owns the
      // read loop, so cancellation is forwarded to it as well as checked at every boundary below.
      const stopReads = (): void => lease.window.cancel();
      signal?.addEventListener("abort", stopReads, { once: true });
      try {
        signal?.throwIfAborted();
        let snapshot = await lease.window.open(files);
        signal?.throwIfAborted();
        // A session total needs every record, so walk the existing paged read back to the start --
        // but only while the whole retained log still fits the window's own byte budget, which keeps
        // one query a bounded read and leaves oversized logs explicitly unknown instead of guessed.
        if (!snapshot.usageComplete && bytes !== undefined && bytes <= WINDOW_MAX_BYTES) {
          for (let page = 0; page < USAGE_PAGE_LIMIT && !snapshot.usageComplete && snapshot.window && !snapshot.window.atStart; page++) {
            const edge = snapshot.window.from;
            signal?.throwIfAborted();
            snapshot = await lease.window.pageUp(files);
            // Paging back into an older run starts a new source, so progress is a new source or a new offset.
            const next = snapshot.window?.from;
            if (next && next.source === edge.source && next.offset === edge.offset) break;
          }
        }
        signal?.throwIfAborted();
        const after = logStates(files);
        // The totals are only published for one consistent snapshot: a log that vanished, shrank or was
        // rewritten in place while it was read cannot prove the numbers still describe this session.
        if (after === undefined || (before !== undefined && after.some((state, index) => rewrittenInPlace(before[index], state)))) return unreadable;
        return projectUsage(snapshot, cli, bytes !== undefined && bytes > WINDOW_MAX_BYTES ? USAGE_TOO_LARGE : USAGE_INCOMPLETE);
      }
      finally {
        signal?.removeEventListener("abort", stopReads);
        lease.release();
      }
    }
    // Reading is best-effort, but a cancelled call is not a successful answer: let it reject.
    catch (error) {
      if (signal?.aborted === true) throw error;
      return unreadable;
    }
  }

  function pump(): void {
    if (!active || active.ctx.sessionManager.getSessionFile() !== active.file) return;
    try {
      deliverHumanActions(active.manager, pi, active.ctx, humanPending);
      active.agents = active.manager.list();
      deliverReports(active.manager, pi, active.ctx, active.pending, Date.now(), active.agents);
    }
    catch (error) { console.error("[pi-cli-subagents] Report delivery failed; retrying:", error); }
    try { active.updatePanel?.(active.agents); active.widget?.update(); }
    catch (error) { console.error("[pi-cli-subagents] Status refresh failed; retrying:", error); }
  }
  function stopMonitor(): void {
    // Clear the old pane while its context is still valid; late finalizers must
    // not remove a replacement session's pane.
    if (active?.ctx.mode === "tui") active.ctx.ui.setWidget(AGENTS_PANEL_KEY, undefined);
    sessionEpoch++;
    humanPending.clear();
    dismissPanel?.(); dismissPanel = undefined;
    if (active) { clearInterval(active.timer); active.widget?.dispose(); }
    active = undefined;
    transcriptCache.clear();
    usageCache.clear();
  }
  pi.on("session_start", (_event, ctx) => {
    stopMonitor();
    refreshRoleCatalog(ctx);
    const file = ctx.sessionManager.getSessionFile();
    if (!file) return;
    const manager = parentManager(ctx, launch);
    const pending = new Set<string>();
    const timer = setInterval(pump, 800);
    timer.unref();
    const monitor: NonNullable<typeof active> = { file, ctx, manager, pending, timer, agents: [] };
    // Status renders the monitor's snapshot; panel actions still re-read live state.
    if (ctx.mode === "tui") {
      monitor.widget = new StatusWidget(ctx.ui, () => monitor.agents);
      // Start the CLI discovery now so `/cli-agents-setting` opens with its pickers already populated.
      cliAvailability = undefined; catalog = undefined; catalogProbe = undefined;
      discover(ctx.cwd);
    }
    active = monitor;
    setTimeout(pump, 100).unref();
  });
  pi.on("session_shutdown", () => stopMonitor());
  pi.on("before_agent_start", (_event, ctx) => refreshRoleCatalog(ctx));

  function refreshRoleCatalog(ctx: ExtensionContext): void {
    try {
      const roles = loadRoles(getAgentDir(), ctx.cwd, ctx.isProjectTrusted());
      registerSubagent(`Available roles (name: description):\n${Object.entries(roles).map(([name, role]) => `${name}: ${role.description.replace(/\s+/g, " ").trim()}`).join("\n")}`);
    } catch (error) {
      registerSubagent("Role catalog unavailable: fix the invalid role configuration before starting a task.");
      ctx.ui.notify(`Cannot refresh subagent roles: ${(error as Error).message}`, "error");
    }
  }

  const registerSubagent = (catalog: string): void => pi.registerTool({
    name: "subagent", label: "CLI subagent",
    description: `Start or continue a persistent CLI subagent. send keeps the same native session: idle starts a new run; closed resumes the original session. interrupt ends the captured run without releasing its runtime; Claude also cancels that run's queued inputs. stop releases a runtime that has no accepted turn in flight; while a turn is in flight it refuses, because releasing would discard that turn — interrupt it first. reclaim frees the accounting of one unreachable runtime whose recorded worker and CLI are both reliably gone: it confirms no native release, leaves the lock and history untouched, and does not make the instance resumable. Sessions, history and results are retained. Answer pending interactions with subagent_reply.\n\nworkspace_create/workspace_integrate manage detached Git worktrees of the parent repository or of the repository at cwd; read the delegate-cli-agents workspaces reference before either. Inherit ALL uncommitted parent changes only with explicit authorization.\n\nGive the goal, necessary context, authorized scope and acceptance criteria; a new instance has not seen this conversation. Let the child choose its approach unless required behavior constrains it.\n\nReports return automatically. Do not sleep or poll for completion; continue independent work or end this turn. Receipts do not prove execution or success. Inspect uncertain outcomes before retrying; do not bypass refusals with replacement instances or edited records.\n\n${catalog}`,
    parameters: Type.Object({
      action: Type.Union([Type.Literal("start"), Type.Literal("send"), Type.Literal("interrupt"), Type.Literal("stop"), Type.Literal("reclaim"), Type.Literal("workspace_create"), Type.Literal("workspace_integrate")], { description: "interrupt requires native captured-turn confirmation; unsupported capabilities reject. send to a stopping instance waits for release before attempting original-session resume; uncertain release rejects. reclaim frees the accounting of one unreachable runtime whose recorded worker and CLI are both reliably gone; it never claims a native release and never makes the instance resumable." }),
      role: Type.Optional(Type.String({ description: "start only, required: configured role name" })),
      task: Type.Optional(Type.String({ description: "start only, required: task and authorized scope" })),
      cwd: Type.Optional(Type.String({ description: "start/workspace_create: absolute, or relative to the parent cwd; start: mutually exclusive with workspace" })),
      workspace: Type.Optional(Type.String({ description: "start/workspace_integrate: managed workspace ID; required for workspace_integrate; start excludes cwd" })),
      id: Type.Optional(Type.String({ description: "send/interrupt/stop/reclaim only, required: existing instance ID" })),
      runtimeId: Type.Optional(Type.String({ description: "reclaim only, required: the exact runtime ID reported by subagent_query get; a different runtime is refused so a retry cannot silently move to a newer owner" })),
      message: Type.Optional(Type.String({ description: "send only, required: follow-up goal, new context and changed constraints; repeat the full task only when needed" })),
      mode: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")], { description: "send only, defaults to steer. Running Pi: steer supplies input before a subsequent model request without cancelling the in-flight tool; followUp waits until the current execution has no more tool calls. Running Codex supports steer only. Claude maps steer to non-aborting next input and followUp to later input; native receipt capabilities are required. This selects child input delivery, not parent report delivery." })),
      baseline: Type.Optional(Type.Union([Type.Literal("keep"), Type.Literal("sync")], { description: "managed-workspace send only, required when a changed baseline needs acknowledgement. keep uses current workspace files; it does not restore remembered files. sync updates from the parent, refuses active, staged or unintegrated work and other runtime owners, and closes the target idle runtime before preflight; a later refusal may leave it closed. Child session memory may be stale after either choice." })),
      includeUncommitted: Type.Optional(Type.Object({ reason: Type.String({ minLength: 1, description: "workspace_create or send with sync only: why ALL current uncommitted parent changes are authorized for inheritance" }) }, { additionalProperties: false })),
    }, { additionalProperties: false }),
    async execute(_id, args, _signal, _update, ctx) {
      if (args.action === "workspace_create") {
        checkFields(args, ["action"], ["cwd", "includeUncommitted"]);
        return content(JSON.stringify(await parentManager(ctx, launch).workspaces.create(path.resolve(ctx.cwd, args.cwd ?? ctx.cwd), { includeUncommitted: args.includeUncommitted })));
      }
      if (args.action === "workspace_integrate") {
        checkFields(args, ["action", "workspace"]);
        return content(JSON.stringify(await parentManager(ctx, launch).workspaces.integrate(args.workspace!)));
      }
      if (args.action === "start") {
        checkFields(args, ["action", "role", "task"], ["cwd", "workspace"]);
        if (args.workspace !== undefined && args.cwd !== undefined) throw new Error("Pass workspace or cwd, not both");
        const roles = loadRoles(getAgentDir(), ctx.cwd, ctx.isProjectTrusted());
        if (!Object.hasOwn(roles, args.role!)) throw new Error(`Unknown role: ${args.role}; available: ${Object.keys(roles).join(", ")}`);
        const resolved = roles[args.role!];
        const state = await parentManager(ctx, launch).spawn(args.role!, inheritParentModel(resolved, ctx), path.resolve(ctx.cwd, args.cwd ?? ctx.cwd), args.task!, args.workspace);
        const result = `Subagent ${state.phase}: ${view(state)}
${receiptText(state)}`;
        if (hasFailure(state)) throw new Error(`${result}\nInspect the instance before retrying; work may already have run.`);
        return content(state.receipt?.status === "accepted" || state.receipt?.status === "queued" ? `${result}\n${REPORT_GUIDANCE}` : result);
      }
      if (args.action === "send") {
        checkFields(args, ["action", "id", "message"], ["mode", "baseline", "includeUncommitted"]);
        const state = await parentManager(ctx, launch).send(args.id!, args.message!, (args.mode ?? "steer") as Delivery,
          { baseline: args.baseline, includeUncommitted: args.includeUncommitted });
        const result = `Subagent ${state.phase} after input request: ${view(state)}
${receiptText(state)}`;
        if (hasFailure(state)) throw new Error(`${result}\nInspect the instance before retrying; work may already have run.`);
        return content(state.receipt?.status === "accepted" || state.receipt?.status === "queued" ? `${result}\n${REPORT_GUIDANCE}` : result);
      }
      if (args.action === "reclaim") {
        checkFields(args, ["action", "id", "runtimeId"]);
        const state = await parentManager(ctx, launch).reclaim(args.id!, args.runtimeId!);
        return content(`${receiptText(state)}
${view(state)}`);
      }
      if (args.action !== "stop" && args.action !== "interrupt") throw new Error("Unknown subagent action; use start, send, interrupt, stop, reclaim, workspace_create or workspace_integrate");
      checkFields(args, ["action", "id"]);
      const manager = parentManager(ctx, launch);
      let captured: { runId: string; runtimeId?: string } | undefined;
      if (args.action === "stop") {
        // Releasing the runtime of an accepted, in-flight turn ends that turn as "Parent requested
        // shutdown" and keeps none of its output. Interrupt is the operation that ends one turn, so
        // refuse here rather than discard work the model did not mean to cancel.
        const observed = manager.get(args.id!);
        captured = { runId: observed.runId, runtimeId: observed.runtimeId };
        if (observed.accepted && ["starting", "running", "waiting"].includes(observed.phase))
          throw new Error(`A turn is in flight (${observed.phase}); stop releases processes without ending it, which would discard that turn. Interrupt first, then stop.`);
      }
      const state = args.action === "interrupt" ? await manager.interrupt(args.id!) : await manager.close(args.id!, false, captured, true);
      // A release receipt proves the released runtime; the retained report is read by identity
      // through subagent_query, so repeating its body here only spends parent context.
      return content(`${receiptText(state)}
${view(state, args.action === "interrupt")}`);
    },
  });
  registerSubagent("Role catalog loads at session start.");
  pi.registerTool({
    name: "subagent_query", label: "Query CLI subagents",
    description: "Inspect this parent's instances without starting or resuming them. idle still owns processes; closed retains the native session. lastStatus describes the last run, not resource release.\n\nlist returns metadata and workspaces; get includes pending requests, a bounded result preview and optional reported usage; usageComplete=false means unknown, not zero. Usage is neither live telemetry nor a bill. If truncated, use result with the original id/runId and follow nextOffset until null; never substitute another run. activity is a paged history projection, not the full final report.\n\nRead complete evidence and verify claims before reporting success.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("get"), Type.Literal("result"), Type.Literal("activity")]),
      id: Type.Optional(Type.String({ description: "get/result/activity only, required: instance ID" })),
      runId: Type.Optional(Type.String({ description: "result only, required: original run ID" })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "result only: UTF-16 offset, default 0" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12000, description: "result: UTF-16 characters, default/max 12000 (one full report); activity: entries, default 20/max 100" })),
      cursor: Type.Optional(Type.String({ minLength: 1, description: "activity only: opaque next-older-page cursor from the previous response; do not edit" })),
      maxBytes: Type.Optional(Type.Integer({ minimum: 4096, maximum: 65536, description: "activity only: total JSON UTF-8 byte budget, default 16384" })),
    }, { additionalProperties: false }),
    async execute(_id, args, signal, _update, ctx) {
      if (args.action === "activity") {
        checkFields(args, ["action", "id"], ["cursor", "limit", "maxBytes"]);
        return content(JSON.stringify(await parentManager(ctx, launch).activity(args.id!,
          { cursor: args.cursor, limit: args.limit, maxBytes: args.maxBytes, signal })));
      }
      if (args.action === "result") {
        checkFields(args, ["action", "id", "runId"], ["offset", "limit"]);
        const offset = args.offset ?? 0, limit = args.limit ?? 12000;
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Result offset must be a non-negative integer");
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 12000) throw new Error("Result limit must be an integer from 1 to 12000");
        const report = parentManager(ctx, launch).getResult(args.id!, args.runId!);
        if (offset > report.text.length) throw new Error("Result offset exceeds totalLength");
        const end = Math.min(report.text.length, offset + limit);
        return content(JSON.stringify({ agentId: report.agentId, runId: report.runId, status: report.status, time: report.time,
          error: report.error, offset, totalLength: report.text.length, nextOffset: end < report.text.length ? end : null,
          text: report.text.slice(offset, end) }));
      }
      if (args.action === "get") checkFields(args, ["action", "id"]);
      else if (args.action === "list") checkFields(args, ["action"]);
      else throw new Error("Unknown query action; use list, get, result or activity");
      const manager = parentManager(ctx, launch);
      // Only `get` carries the on-demand native usage projection; list and receipts stay unchanged.
      const agents = await Promise.all((args.action === "get" ? [manager.get(args.id!)] : manager.list()).map(async state =>
        ({ ...visible(state, args.action === "get"), ...(args.action === "get" ? await reportedUsage(manager, state.id, state, signal) : {}) })));
      return content(JSON.stringify({ agents, workspaces: await manager.workspaces.list() }));
    },
  });
  pi.registerTool({
    name: "subagent_reply", label: "Answer child interaction",
    description: "Answer a child's current task question or review its permission request within the user's authorization. Read the complete request first; parentPolicy defines supported replies, not authorization or one-action effects. Submit exactly one response matching the request. Task answers provide context, not new authorization.\n\nHandle routine authorized decisions yourself. Never grant session-wide or persistent permissions. Escalate unclear context, effects or authorization, explicit user-confirmation requirements, or requests requiring the human UI; explain the decision needed and use /agents (select the child, i details, r reply).",
    parameters: Type.Object({
      id: Type.String({ description: "Existing instance ID" }),
      questionId: Type.String({ description: "Exact current interaction ID" }),
      confirmed: Type.Optional(Type.Boolean({ description: "confirm only: native yes/no response; inspect the request to establish its effect before confirming" })),
      value: Type.Optional(Type.String({ description: "task question: an offered label or custom answer text, submitted once; other select: exact offered option; input/editor: response text" })),
      answers: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()), { description: "form only: map every field ID to its answer strings; empty arrays skip optional fields; required:true needs one non-blank string. multiSelect:false takes at most one string; true permits choices plus one custom answer. Preserve exact text and respect offered choices/allowOther." })),
      cancelled: Type.Optional(Type.Literal(true, { description: "Cancel instead of answering" })),
      reason: Type.String({ minLength: 1, description: "Why the decision is within the user's authorization, or why it is denied/cancelled" }),
    }, { additionalProperties: false }),
    async execute(_id, args, _signal, _update, ctx) {
      checkFields(args, ["id", "questionId", "reason"], ["confirmed", "value", "answers", "cancelled"]);
      const state = await parentManager(ctx, launch).reply(args.id, args.questionId,
        { confirmed: args.confirmed, value: args.value, answers: args.answers, cancelled: args.cancelled }, { actor: "parent", reason: args.reason });
      return content(`Response accepted for the child's current interaction; delivery is not proof the action completed: ${view(state)}`);
    },
  });

  // The human entry point remains available when the parent cannot decide safely.
  const describeAnswer = (answer: { value?: string; answers?: QuestionAnswers; confirmed?: boolean; cancelled?: boolean }): string => {
    if (answer.cancelled) return "cancelled";
    if (answer.answers) return "answered task form";
    if (typeof answer.confirmed === "boolean") return answer.confirmed ? "confirmed" : "declined";
    return `replied "${oneLine(answer.value, 200)}"`;
  };
  async function replyPrompt(ctx: ExtensionContext, manager: AgentManager, id: string, questionId: string): Promise<void> {
    const epoch = sessionEpoch;
    const q: Question | undefined = manager.get(id).questions.find((entry) => entry.id === questionId);
    if (!q) throw new Error("This request has ended or does not belong to this session");
    // Presentation only: native option values and human answers remain verbatim.
    const display = (text: string): string => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e-\u200f\u2028-\u202e\u2066-\u2069]/gu,
      char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
    let answer: { value?: string; answers?: QuestionAnswers; confirmed?: boolean; cancelled?: boolean };
    if (q.method === "form") {
      if (!q.fields?.length) throw new Error("The task form has no fields");
      const entries: [string, string[]][] = [];
      let cancelled = false;
      for (const field of q.fields) {
        if (epoch !== sessionEpoch) return;
        const previews = field.options.flatMap(option => option.preview === undefined ? [] :
          [`\nPreview (plain text): ${JSON.stringify({ label: option.label, preview: option.preview })}`]).join("");
        const title = display(`${q.title ? `${q.title}\n` : ""}${q.humanOnly ? "Human response required by native policy.\n" : ""}${field.isSecret ? "Sensitive question: input is visible in Pi and saved history.\n" : ""}[${field.header}] ${field.question}${field.description ? `\n${field.description}` : ""}${previews}`);
        if (field.multiSelect) {
          const selected = new Set<number>();
          let other: string | undefined;
          for (;;) {
            if (epoch !== sessionEpoch) return;
            const choices = field.options.map((option, index) => display(`${index + 1}. [${selected.has(index) ? "x" : " "}] ${option.label} — ${option.description}`));
            const custom = `${choices.length + 1}. ${other === undefined ? "Type something." : "Edit other answer."}`;
            const finish = `${choices.length + (field.allowOther ? 2 : 1)}. Finish selection.`;
            const choice = await ctx.ui.select(display(`${title}${other === undefined ? "" : `\nOther answer: ${JSON.stringify(other)}`}`),
              [...choices, ...(field.allowOther ? [custom] : []), finish]);
            if (epoch !== sessionEpoch) return;
            if (choice === undefined) { cancelled = true; break; }
            if (choice === finish) break;
            if (choice === custom && field.allowOther) {
              other = await ctx.ui.input(title, display(other ?? ""));
              if (other === undefined) { cancelled = true; break; }
            } else {
              const index = choices.indexOf(choice);
              if (index < 0) throw new Error("Response is not an offered form choice");
              if (selected.has(index)) selected.delete(index); else selected.add(index);
            }
          }
          if (cancelled) break;
          entries.push([field.id, [...field.options.flatMap((option, index) => selected.has(index) ? [option.label] : []), ...(other ? [other] : [])]]);
          continue;
        }
        let value: string | undefined;
        if (field.options.length) {
          const choices = field.options.map((option, index) => display(`${index + 1}. ${option.label} — ${option.description}`));
          const custom = `${choices.length + 1}. Type something.`;
          const selected = await ctx.ui.select(title, field.allowOther ? [...choices, custom] : choices);
          if (epoch !== sessionEpoch) return;
          value = selected === custom && field.allowOther ? await ctx.ui.input(title, "") :
            field.options[choices.indexOf(selected ?? "")]?.label;
        } else value = await ctx.ui.input(title, "");
        if (value === undefined) { cancelled = true; break; }
        entries.push([field.id, [value]]);
      }
      answer = cancelled ? { cancelled: true } : { answers: Object.fromEntries(entries) };
    } else if (q.method === "confirm") answer = { confirmed: await ctx.ui.confirm(display(q.title), display(q.message ?? "")) };
    else if (q.method === "select") {
      const freeText = q.kind === "question" && q.parentPolicy?.text === true && q.humanOnly !== true;
      const options = q.options ?? [];
      const choices = options.map((option, index) => `${index + 1}. ${display(option)}`);
      const custom = `${choices.length + 1}. Type something.`;
      const selected = await ctx.ui.select(display(q.message ? `${q.title}\n\n${q.message}` : q.title), freeText ? [...choices, custom] : choices);
      if (epoch !== sessionEpoch) return;
      const value = freeText && selected === custom ? await ctx.ui.input(display(q.title), "") : options[choices.indexOf(selected ?? "")];
      answer = value === undefined ? { cancelled: true } : { value };
    } else if (q.method === "editor") {
      const prefill = q.prefill === undefined ? undefined : display(q.prefill);
      const edited = await ctx.ui.editor(display(q.title), prefill);
      const value = edited === prefill ? q.prefill : edited;
      answer = value === undefined ? { cancelled: true } : { value };
    } else {
      const value = await ctx.ui.input(display(q.title), q.placeholder === undefined ? undefined : display(q.placeholder));
      answer = value === undefined ? { cancelled: true } : { value };
    }
    if (epoch !== sessionEpoch) return;
    const answered = await manager.reply(id, questionId, answer);
    recordHumanAction(ctx, manager, answered, `Answered pending request ${questionId}: ${describeAnswer(answer)}.`, epoch);
    if (epoch === sessionEpoch) ctx.ui.notify(`Human response accepted for subagent ${id}`, "info");
  }

  async function sendHuman(ctx: ExtensionContext, manager: AgentManager, id: string, message: string, epoch: number, action: string): Promise<AgentView | undefined> {
    let state: AgentView;
    let options: ResumeOptions = {};
    try { state = await sendAndRecord(ctx, manager, id, message, epoch, action); }
    catch (error) {
      if (!(error instanceof WorkspaceDecisionRequired) || error.decision !== "baseline") throw error;
      if (epoch !== sessionEpoch) return;
      ctx.ui.notify(error.message, "warning");
      const choice = await ctx.ui.select("Choose workspace baseline", ["keep — current workspace, no parent sync", "sync — update workspace from parent"]);
      if (!choice || epoch !== sessionEpoch) return;
      options = { baseline: choice.startsWith("keep") ? "keep" : "sync", expectedRevision: error.workspace.revision };
      try { state = await sendAndRecord(ctx, manager, id, message, epoch, action, options); }
      catch (error) {
        if (!(error instanceof WorkspaceDecisionRequired) || error.decision !== "inherit") throw error;
        if (epoch !== sessionEpoch) return;
        const confirmed = await ctx.ui.confirm("Inherit these uncommitted parent changes?", `${error.parentChanges.join("\n")}\n\nConfirm only if ALL these changes are authorized for this task. The parent index, HEAD and branches will not change.`);
        if (!confirmed || epoch !== sessionEpoch) return;
        options = { ...options, expectedParentTree: error.parentTree,
          includeUncommitted: { reason: "The human explicitly confirmed the displayed parent changes in the TUI." } };
        state = await sendAndRecord(ctx, manager, id, message, epoch, action, options);
      }
    }
    return state;
  }

  let panelBusy = false;
  /** Widget slot for the role editor, rendered by Pi in the area just above the editor. */
  const ROLE_SETTINGS_KEY = "cli-subagents-role-settings";
  /** The roster uses the same slot, so both panes sit above the editor instead of over it. */
  const AGENTS_PANEL_KEY = "cli-subagents-agents";
  type PaneWidget = { terminal: { rows: number }; requestRender(): void };
  /** What one roster action still owes the command loop: another iteration, or nothing after a session change. */
  type PanelStep = "next" | "stop";
  /** Discovered once per session and shared by every panel, so the pickers are ready when it opens. */
  let catalog: ModelCatalog | undefined;
  let catalogProbe: Promise<void> | undefined;
  let cliAvailability: ReturnType<typeof detectClis> | undefined;
  const discover = (cwd: string): void => {
    cliAvailability ??= detectClis();
    catalogProbe ??= probeCatalog({ pi: launch, cwd, available: cliAvailability }).then((found) => { catalog = found; });
  };
  /**
   * Show one instance's conversation in the overlay and return the action it produced, so a message
   * typed inside the viewer is handled by the same loop as a panel action. The overlay owns the
   * keyboard while it is open, which the roster's input listener has to know.
   */
  async function showConversation(ctx: ExtensionContext, manager: AgentManager, epoch: number, id: string,
    setOverlay: (active: boolean) => void): Promise<PanelAction | undefined> {
    const selected = manager.get(id);
    // One paged window per instance: reuse it while this process has it, never scan history unprompted.
    const identity: TranscriptIdentity = { parentFile: manager.parentFile, agentId: id, cli: selected.cli ?? "pi",
      ...(selected.session?.cli === "codex" ? { nativeId: selected.session.threadId } : selected.session?.cli === "claude" ? { nativeId: selected.session.sessionId } : {}) };
    const lease = await transcriptCache.acquire(identity, manager.eventLogs(id),
      () => new TranscriptWindow(identity.cli, identity.nativeId));
    let viewer: ConversationViewer | undefined;
    try {
      return await ctx.ui.custom<PanelAction | undefined>((tui, theme, keybindings, done) => {
        setOverlay(true);
        dismissPanel = () => { viewer?.dispose(); done(undefined); };
        const files = () => manager.eventLogs(id);
        viewer = new ConversationViewer(tui, theme, done, async () => ({
          agent: manager.get(id), ...await lease.window.open(files()),
        }), { keybindings, markdownTheme: getMarkdownTheme(),
          paging: { older: async (boundary) => ({ agent: manager.get(id), ...await lease.window.pageUp(files(), boundary) }),
            newer: async (boundary) => ({ agent: manager.get(id), ...await lease.window.pageDown(files(), boundary) }),
            latest: async () => ({ agent: manager.get(id), ...await lease.window.toTail(files()) }) },
          onSend: async (message) => {
            try {
              const sent = await sendAndRecord(ctx, manager, id, message, epoch, "Requested input");
              return sent;
            }
            catch (error) {
              if (error instanceof WorkspaceDecisionRequired) return { kind: "message", id, resume: true, message };
              throw error;
            }
          },
          // Match Pi's input box: its border follows the main session's thinking level.
          frameColor: (text) => ctx.ui.theme.getThinkingBorderColor(ctx.thinkingLevel ?? "off")(text) });
        return viewer;
      }, { overlay: true, overlayOptions: { width: "96%", maxHeight: "100%", margin: 1 } });
    } finally { setOverlay(false); viewer?.dispose(); lease.release(); dismissPanel = undefined; }
  }

  /** Release every captured idle target the roster selected once, reporting one outcome per target. */
  async function releaseIdleTargets(ctx: ExtensionContext, manager: AgentManager, epoch: number, targets: AgentView[]): Promise<PanelStep> {
    if (!targets.length) return "next";
    const confirmed = await ctx.ui.confirm("Release idle subagent processes?", targets
      .map(target => `${oneLine(target.role, 120)} ${target.id} (run ${target.runId})`).join("\n")
      + "\n\nRelease only these captured idle runtimes. This can stop background work; sessions, files and completed results are retained. Changed or busy targets are refused, not retried.");
    if (!confirmed || epoch !== sessionEpoch) return "next";
    const outcomes: string[] = [];
    let uncertain = false;
    for (const target of targets) {
      if (epoch !== sessionEpoch) return "stop";
      let result = target, message: string;
      try {
        result = await manager.close(target.id, true, { runId: target.runId, runtimeId: target.runtimeId! });
        message = receiptText(result);
        if (result.receipt?.status !== "released") uncertain = true;
      } catch (error) {
        uncertain = true;
        message = `Idle release request unconfirmed: ${(error as Error).message}\nInspect before retrying.`;
      }
      // Use the captured target on refusal, not a later run from a fresh list.
      recordHumanAction(ctx, manager, result, `Batch idle release: ${message}`, epoch);
      outcomes.push(`${oneLine(target.role, 120)} ${target.id}: ${message}`);
    }
    if (epoch !== sessionEpoch) return "stop";
    ctx.ui.notify(uncertain ? outcomes.join("\n") : `Released ${targets.length} idle subagent${targets.length === 1 ? "" : "s"}.`, uncertain ? "warning" : "info");
    return "next";
  }

  /** Confirm one captured interrupt, idle release, or uncertain-runtime recovery. */
  async function interruptOrRelease(ctx: ExtensionContext, manager: AgentManager, epoch: number,
    action: Extract<PanelAction, { kind: "stop" | "interrupt" | "release-uncertain" }>, state: AgentView): Promise<PanelStep> {
    const release = action.kind !== "interrupt", uncertain = action.kind === "release-uncertain";
    if (state.runId !== action.expected.runId || state.runtimeId !== action.expected.runtimeId || release && !(uncertain ? canReleaseUncertain(state) : canRelease(state))) {
      ctx.ui.notify(`${state.role} is no longer the captured ${release ? `${uncertain ? "uncertain" : "idle"} runtime` : "turn"}; nothing was ${release ? "released" : "interrupted"}.`, "warning"); return "next";
    }
    const confirmed = await ctx.ui.confirm(uncertain ? "Release uncertain subagent?" : release ? "Release idle subagent?" : "Interrupt the current subagent turn?", uncertain
      ? `${state.role} ${action.id.slice(0, 8)}, runtime ${state.runtimeId}: request release of this uncertain runtime. This may end active work and discard unreported output; it does not prove whether the input executed or undo file changes. Keep the native session and recorded results. Changed ownership or a known accepted turn is refused.`
      : release
      ? `${state.role} ${action.id.slice(0, 8)}: release only this idle runtime. Keep the native session, last run outcome and results. Changed or busy targets are refused.`
      : `${state.role} ${action.id.slice(0, 8)}: end only the current turn, retaining the runtime and native session. This does not undo file changes.`);
    if (!confirmed || epoch !== sessionEpoch) return "next";
    let result: AgentView;
    try { result = action.kind === "interrupt" ? await manager.interrupt(action.id, action.expected) : await manager.close(action.id, !uncertain, action.expected, uncertain); }
    catch (error) {
      recordHumanAction(ctx, manager, state, `${release ? "Release" : "Interrupt"} request unconfirmed: ${(error as Error).message}\nInspect before retrying.`, epoch);
      throw error;
    }
    recordHumanAction(ctx, manager, result, receiptText(result), epoch);
    if (epoch !== sessionEpoch) return "stop";
    ctx.ui.notify(release && result.receipt?.status === "released" ? `Released ${oneLine(state.role, 120)} ${action.id.slice(0, 8)}.` : receiptText(result), result.receipt?.status === "unconfirmed" ? "warning" : "info");
    return "next";
  }

  /** Send one roster message, or start/resume the instance's run once its phase allows that. */
  async function messageFromRoster(ctx: ExtensionContext, manager: AgentManager, epoch: number,
    action: Extract<PanelAction, { kind: "message" }>, state: AgentView): Promise<PanelStep> {
    if (state.phase === "waiting") { ctx.ui.notify("This child has a pending interaction: use r in its details or subagent_reply; a message is not an answer.", "error"); return "next"; }
    if (!canMessage(state)) { ctx.ui.notify(`Cannot message this child while ${state.phase}; inspect it before continuing.`, "error"); return "next"; }
    const steerable = canSteer(state.phase);
    const resuming = canResume(state.phase);
    const message = action.message ?? await ctx.ui.editor(resuming ? `Resume ${state.role} in the original session` : state.phase === "idle" ? `New task for ${state.role}` : `Message ${state.role}`, "");
    if (!message?.trim() || epoch !== sessionEpoch) return "next";
    if (!steerable) ctx.ui.notify("Starting a new turn in the original session; this can take up to about 60 seconds...", "info");
    const sent = await sendHuman(ctx, manager, action.id, message, epoch,
      steerable ? "Requested input" : resuming ? "Requested original-session continuation with" : "Requested a new resident task with");
    if (epoch !== sessionEpoch) return "stop";
    if (!sent) return "next";
    ctx.ui.notify(receiptText(sent), sent.receipt?.status === "unconfirmed" ? "warning" : "info");
    return "next";
  }

  async function openAgents(ctx: ExtensionContext): Promise<void> {
      // The roster is a widget above the editor, so it needs Pi's TUI layout and raw input.
      if (ctx.mode !== "tui") { ctx.ui.notify("The panel requires a TUI; parent tools remain available through subagent_query, subagent and subagent_reply.", "error"); return; }
      // Keep one panel/action loop per extension instance so concurrent commands cannot compete for input.
      if (panelBusy) { ctx.ui.notify("The agent panel is already open or processing an action; wait or close it with Esc.", "warning"); return; }
      panelBusy = true;
      const epoch = sessionEpoch;
      const monitor = active?.file === ctx.sessionManager.getSessionFile() ? active : undefined;
      let panel: AgentsPanel | undefined;
      let widget: PaneWidget | undefined;
      let overlayActive = false;
      // Unset while a host dialog or the conversation overlay owns the keyboard, so this listener
      // never swallows a dialog's input.
      let deliver: ((data: string) => void) | undefined;
      const refresh = () => widget?.requestRender();
      // A modal overlay does not bubble input to Pi's editor. Route Ctrl+C to
      // the public parent abort API, never to the selected child's interrupt.
      const stopInput = ctx.ui.onTerminalInput((data) => {
        if (epoch !== sessionEpoch) return undefined;
        if (matchesKey(data, "ctrl+c")) {
          if (!overlayActive) return undefined;
          if (ctx.isIdle()) dismissPanel?.(); else ctx.abort();
          return { consume: true };
        }
        if (!deliver) return undefined;
        deliver(data); refresh(); return { consume: true };
      });
      ctx.ui.setWidget(AGENTS_PANEL_KEY, (tui) => {
        widget = tui;
        return { render: (width: number) => panel?.render(width) ?? [], invalidate: () => {} };
      });
      const theme = ctx.ui.theme;
      const frameColor = (text: string) => ctx.ui.theme.getThinkingBorderColor(ctx.thinkingLevel ?? "off")(text);
      try {
        const manager = parentManager(ctx, launch);
        while (epoch === sessionEpoch) {
          let agents: AgentView[] = [];
          try { agents = manager.list(); }
          catch (error) { ctx.ui.notify((error as Error).message, "error"); return; }
          if (!agents.length) { ctx.ui.notify("No subagents in this session.", "info"); return; }
          let action = await new Promise<PanelAction | undefined>((resolve) => {
            let settled = false;
            const done = (result: PanelAction | undefined) => {
              if (settled) return;
              settled = true; deliver = undefined;
              if (monitor) monitor.updatePanel = undefined;
              resolve(result);
            };
            // Esc during shutdown must still release this loop.
            dismissPanel = () => done(undefined);
            panel = new AgentsPanel(agents, theme, done, { rows: () => paneRows(widget?.terminal.rows ?? 24, panel?.mode ?? "list"), frameColor,
              frame: () => monitor?.widget?.animationFrame ?? 0 });
            if (monitor) monitor.updatePanel = (snapshot) => { panel?.update(snapshot); refresh(); };
            deliver = (data) => panel?.handleInput(data);
            refresh();
          });
          dismissPanel = undefined;
          if (!action || epoch !== sessionEpoch) return;
          try {
            // The conversation overlay hands back the next action, so a key pressed inside the viewer is
            // handled by this same iteration instead of reopening the roster.
            let pending: PanelAction | undefined = action;
            if (action.kind === "view") {
              pending = await showConversation(ctx, manager, epoch, action.id, (active) => { overlayActive = active; });
              if (epoch !== sessionEpoch) return;
            }
            if (!pending || pending.kind === "view") continue;
            if (pending.kind === "close-idle") { if (await releaseIdleTargets(ctx, manager, epoch, pending.targets) === "stop") return; continue; }
            // Re-read state before acting: the list is a snapshot, not an authorization or lifecycle guarantee.
            const state = manager.get(pending.id);
            if (pending.kind === "reply") { await replyPrompt(ctx, manager, pending.id, pending.questionId); continue; }
            if (pending.kind === "stop" || pending.kind === "interrupt" || pending.kind === "release-uncertain") { if (await interruptOrRelease(ctx, manager, epoch, pending, state) === "stop") return; continue; }
            if (await messageFromRoster(ctx, manager, epoch, pending, state) === "stop") return;
          } catch (error) { if (epoch !== sessionEpoch) return; ctx.ui.notify((error as Error).message, "error"); }
        }
      } catch (error) { if (epoch === sessionEpoch) ctx.ui.notify((error as Error).message, "error"); }
      finally {
        if (monitor) monitor.updatePanel = undefined;
        panel = undefined; widget = undefined; deliver = undefined;
        stopInput();
        if (epoch === sessionEpoch) ctx.ui.setWidget(AGENTS_PANEL_KEY, undefined);
        dismissPanel = undefined; panelBusy = false;
      }
  }
  pi.registerCommand("agents", {
    description: "Manage subagents: view conversations and last run outcomes, message, start an idle task, resume, reply, interrupt a turn or release processes (including a confirmed idle-only batch)",
    handler: (_args, ctx) => openAgents(ctx),
  });

  /** What one role-editor session edits: its parent epoch, current scope and cursor, plus the draft and last disk contents. */
  type RoleSettingsSession = {
    epoch: number; scope: Scope; cursor: RoleSettingsCursor;
    disk: Record<Scope, Record<string, Role>>; draft: Record<Scope, Record<string, Role>>; dirty: Record<Scope, boolean>;
  };

  /**
   * Apply one role-editor action to the draft, and report whether the panel is done ("stop") or should
   * reopen with what the action left behind ("next"). Every write still happens through `writeScope`,
   * which validates the document and refuses a stale disk snapshot.
   */
  async function applyRoleSettingsAction(ctx: ExtensionContext, action: RoleSettingsAction, session: RoleSettingsSession,
    preview: Record<string, Role>, agentDir: string, cwd: string): Promise<PanelStep> {
    const { disk, draft, dirty, epoch } = session, scope = session.scope;
    if (action.kind === "close") {
      if (!dirty.user && !dirty.project) return "stop";
      const discard = await ctx.ui.confirm("Discard unsaved role changes?", `Unsaved edits in: ${
        ["user", "project"].filter((item): item is Scope => dirty[item as Scope]).map((item) => item === "user" ? "personal" : "project").join(", ")}. The files on disk are unchanged.`);
      if (epoch !== sessionEpoch) return "stop";
      return discard ? "stop" : "next";
    }
    // Both scopes list the merged role set, so only the edited document and the overrides change here;
    // the cursor is cleared so the newly selected scope still starts from the top of the list.
    if (action.kind === "scope") { session.scope = action.scope; session.cursor = {}; return "next"; }
    if (action.kind === "save") {
      const file = writeScope(scope, agentDir, cwd, draft[scope], disk[scope]);
      disk[scope] = readScope(scope, agentDir, cwd); draft[scope] = structuredClone(disk[scope]); dirty[scope] = false;
      refreshRoleCatalog(ctx);
      ctx.ui.notify(`Saved ${file}`, "info");
      return "next";
    }
    if (action.kind === "set" || action.kind === "edit") {
      // Kept even when a dialog is cancelled, so the same field stays under the cursor.
      session.cursor = { role: action.role, field: action.field };
      const base = Object.hasOwn(preview, action.role) ? preview[action.role] : undefined;
      if (!base) throw new Error(`Unknown role: ${action.role}`);
      const field = action.field, role = Object.hasOwn(draft[scope], action.role) ? draft[scope][action.role] : base;
      const value = action.kind === "set" ? action.value : field === "instructions" || field === "description"
        ? await ctx.ui.editor(`${field === "instructions" ? "Instructions" : "Description"} for ${action.role}`, fieldValue(role, field))
        : await ctx.ui.input(`${FIELD_LABELS[field]} for ${action.role}`, field === "model" ? "Exact model name or alias" : "", undefined);
      if (value === undefined || epoch !== sessionEpoch) return "next";
      draft[scope] = setField(draft[scope], action.role, base, field, value); dirty[scope] = true;
      // A catalog selection names a pair; free text and later edits remain independent.
      if (action.kind === "set" && field === "model" && action.provider)
        draft[scope][action.role].provider = action.provider;
      if (field === "provider" && catalog?.pi.length) {
        const next = inheritParentModel(draft[scope][action.role], ctx);
        if (next.provider && next.model && !catalog.pi.some(entry => entry.provider === next.provider && entry.model === next.model))
          ctx.ui.notify(`Model ${next.model} is not listed for provider ${next.provider}; it was kept. Choose a model or verify your custom configuration.`, "warning");
      }
      return "next";
    }
    if (action.kind === "add") {
      const name = await ctx.ui.input("New role name", "lowercase, e.g. tester");
      if (name === undefined || epoch !== sessionEpoch) return "next";
      const clean = name.trim();
      if (!/^[a-z][a-z0-9-]*$/.test(clean)) { ctx.ui.notify("Role names use lowercase letters, digits and dashes.", "error"); return "next"; }
      if (Object.hasOwn(preview, clean)) { ctx.ui.notify(`Role ${clean} already exists; select it and press enter to customize it here.`, "warning"); return "next"; }
      draft[scope] = addRole(draft[scope], clean); dirty[scope] = true;
      session.cursor = { role: clean };   // the new role needs its description and instructions written
      return "next";
    }
    const label = scope === "user" ? "personal" : "project";
    const confirmed = await ctx.ui.confirm(`Remove ${action.role} from ${label} roles?`, "Lower-scope definitions apply again. Other scopes are untouched.");
    if (!confirmed || epoch !== sessionEpoch) return "next";
    draft[scope] = deleteRole(draft[scope], action.role); dirty[scope] = true; session.cursor = {};
    return "next";
  }

  async function openRoleSettings(ctx: ExtensionContext): Promise<void> {
    // The panel is a widget above the editor, so it needs Pi's TUI layout and raw input.
    if (ctx.mode !== "tui") { ctx.ui.notify("Role settings need the TUI; edit ~/.pi/agent/cli-subagents.roles.json or .pi/cli-subagents.roles.json directly.", "error"); return; }
    if (panelBusy) { ctx.ui.notify("Another panel is open; close it with Esc before editing roles.", "warning"); return; }
    panelBusy = true;
    const epoch = sessionEpoch;
    const agentDir = getAgentDir(), cwd = ctx.cwd, trusted = ctx.isProjectTrusted();
    const disk = {} as Record<Scope, Record<string, Role>>, draft = {} as Record<Scope, Record<string, Role>>;
    const dirty: Record<Scope, boolean> = { user: false, project: false };
    const session: RoleSettingsSession = { epoch, scope: trusted ? "project" : "user", cursor: {}, disk, draft, dirty };
    let panel: RoleSettingsPanel | undefined;
    let widget: PaneWidget | undefined;
    // Unset while a host dialog owns the keyboard, so this listener never swallows a dialog's input.
    let deliver: ((data: string) => void) | undefined;
    const refresh = () => widget?.requestRender();
    // Ctrl+C stays with Pi so the host can still interrupt while the panel is open.
    const stopInput = ctx.ui.onTerminalInput((data) => {
      if (!deliver || data === "\u0003") return undefined;
      deliver(data); refresh(); return { consume: true };
    });
    ctx.ui.setWidget(ROLE_SETTINGS_KEY, (tui) => {
      widget = tui;
      return { render: (width: number) => panel?.render(width) ?? [], invalidate: () => {} };
    });
    const theme = ctx.ui.theme;
    // Only CLIs this machine can launch are offered; one installed later appears after /reload.
    discover(cwd);
    const available = cliAvailability ?? detectClis(), clis = CLI_CHOICES.filter((choice) => available[choice]);
    void catalogProbe?.then(() => refresh());
    let defaults: NativeDefaults | undefined;
    // Per-open snapshot; late reads must never repaint a closed or replacement pane.
    void probeRoleDefaults(cwd, available).then(found => {
      if (epoch !== sessionEpoch || !widget) return;
      defaults = found; refresh();
    });
    const displayDefaults = (role: Role) => {
      if ((role.cli ?? "pi") === "pi") {
        const parent = inheritParentModel(role, ctx);
        return { provider: parent.provider ?? "default", model: parent.model ?? "default", thinking: parent.thinking ?? "default" };
      }
      const unknown = defaults ? "unavailable" : "loading…";
      if (role.cli === "codex") return defaults?.codex ?? { model: unknown, effort: unknown, mode: unknown, defaultModeQuestions: unknown };
      return defaults?.claude ? claudeDefaultValues(defaults.claude, role) : { model: unknown, thinking: unknown, mode: unknown };
    };
    try {
      try {
        disk.user = readScope("user", agentDir, cwd);
        disk.project = trusted ? readScope("project", agentDir, cwd) : {};
      } catch (error) { ctx.ui.notify((error as Error).message, "error"); return; }
      draft.user = structuredClone(disk.user); draft.project = structuredClone(disk.project);
      // Reopening where the user left off: every action rebuilds the panel from current state.
      while (epoch === sessionEpoch) {
        const preview = mergeRoles([session.scope === "user" ? draft.user : disk.user, session.scope === "project" ? draft.project : disk.project]);
        const rows = roleRows(preview, draft.user, draft.project, session.scope);
        const action = await new Promise<RoleSettingsAction | undefined>((resolve) => {
          let settled = false;
          const done = (result: RoleSettingsAction | undefined) => { if (!settled) { settled = true; deliver = undefined; resolve(result); } };
          // Shutdown or session replacement must also settle the pending pane action.
          dismissPanel = () => done(undefined);
          // A lower-screen pane: tall enough to be useful, never taller than a third of the terminal.
          panel = new RoleSettingsPanel(rows, session.scope, trusted, dirty[session.scope], theme, done,
            () => Math.max(6, Math.min(SETTINGS_MAX_ROWS + 4, Math.floor((widget?.terminal.rows ?? 24) / 3))),
            (text) => ctx.ui.theme.getThinkingBorderColor(ctx.thinkingLevel ?? "off")(text),
            () => ({ clis, defaults: displayDefaults, ...(catalog ? { catalog } : {}), ...(catalog ? {} : { pending: true }) }), session.cursor);
          deliver = (data) => panel?.handleInput(data);
          refresh();
        });
        dismissPanel = undefined;
        if (!action || epoch !== sessionEpoch) return;
        try {
          if (await applyRoleSettingsAction(ctx, action, session, preview, agentDir, cwd) === "stop") return;
        } catch (error) { ctx.ui.notify((error as Error).message, "error"); }
      }
    } finally {
      panel = undefined;
      widget = undefined;
      deliver = undefined;
      stopInput();
      ctx.ui.setWidget(ROLE_SETTINGS_KEY, undefined);
      dismissPanel = undefined; panelBusy = false;
    }
  }

  pi.registerCommand("cli-agents-setting", {
    description: "Configure subagent roles (CLI, model, thinking, effort, mode) in a pane above the editor",
    handler: (_args, ctx) => openRoleSettings(ctx),
  });
  pi.registerShortcut(Key.ctrlAlt("a"), {
    description: "Open the subagent roster while the parent is working",
    handler: openAgents,
  });
}
