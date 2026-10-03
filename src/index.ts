import { Type } from "@earendil-works/pi-ai";
import { Key } from "@earendil-works/pi-tui";
import { getAgentDir, getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "./manager.js";
import { WorkspaceDecisionRequired, type ResumeOptions } from "./workspace.js";
import { customType as reportType, deliverReports } from "./notifier.js";
import { renderReportMessage } from "./ui/report.js";
import { CLI_CHOICES, loadRoles, mergeRoles } from "./roles.js";
import { detectClis, probeCatalog, type ModelCatalog } from "./cli-discovery.js";
import { addRole, deleteRole, FIELD_LABELS, fieldValue, readScope, roleRows, setField, writeScope, type Scope } from "./role-settings.js";
import { AgentsPanel, paneRows, type PanelAction } from "./ui/panel.js";
import { RoleSettingsPanel, SETTINGS_MAX_ROWS, type RoleSettingsAction, type RoleSettingsCursor } from "./ui/role-settings.js";
import { canSteer, isTerminal, oneLine } from "./ui/format.js";
import { StatusWidget } from "./ui/status.js";
import { FleetView } from "./ui/fleet.js";
import { TranscriptWindow } from "./ui/transcript-window.js";
import { TranscriptCache, type TranscriptIdentity } from "./ui/transcript-cache.js";
import { ConversationViewer } from "./ui/conversation.js";
import type { AgentView, Delivery, Launch, Question, Role, Thinking } from "./types.js";

export function parentManager(ctx: Pick<ExtensionContext, "sessionManager">, launch: Launch): AgentManager {
  const parentFile = ctx.sessionManager.getSessionFile();
  if (!parentFile) throw new Error("A persistent parent session is required (do not use --no-session) to route and replay child reports.");
  return new AgentManager(parentFile, launch);
}

function visible(state: AgentView, includeText = true) {
  // `task`, `history` and `startedAt` let the parent match an instance to its assignments
  // after its own context is compacted, without reading the child's transcript.
  const { id, cli, role, phase, task, history, runCount, runId, sessionId, session, cwd, startedAt, updatedAt, lastActivity, questions, text, truncated, error, logFile } = state;
  return { id, cli, role, phase, runId, sessionId, ...(session?.cli === "codex" ? { threadId: session.threadId } : {}), cwd, updatedAt, lastActivity, questions, ...(includeText ? { text, truncated } : {}), error, logFile, history, runCount,
    ...(state.workspace ? { workspace: state.workspace, workspaceBaseline: state.workspaceBaseline } : {}), ...(task ? { task } : {}), ...(startedAt ? { startedAt } : {}) };
}
const view = (state: AgentView): string => JSON.stringify(visible(state));
const content = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
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
export const humanActionType = "cli-subagents-human-action";

export default function extension(pi: ExtensionAPI): void {
  // Explicit child marker prevents an auto-discovered copy of this extension from recursively spawning agents.
  if (process.env.PI_CLI_SUBAGENT === "1") return;
  pi.registerMessageRenderer(reportType, renderReportMessage);
  const cli = process.argv[1];
  const launch: Launch = { command: process.execPath, args: [cli] };
  let dismissPanel: (() => void) | undefined;
  let sessionEpoch = 0;

  /**
   * The parent coordinates this instance, so a direct human action must not be invisible to it.
   * It is recorded without starting a turn: routine additions should not interrupt sibling work,
   * and the entry is already in context when the child's own report arrives.
   */
  function recordHumanAction(ctx: ExtensionContext, agent: AgentView, action: string): void {
    const text = `[Human → subagent ${agent.id} · ${agent.role}] ${action}\n`
      + "The user acted on this instance directly. Re-check your plan for it before integrating or dispatching related work. This does not widen the task's original authorization.";
    try { pi.sendMessage({ customType: humanActionType, content: text, display: true, details: { agentId: agent.id, role: agent.role } }, { triggerTurn: false }); }
    catch (error) { ctx.ui.notify(`The parent agent was not told about this action: ${(error as Error).message}`, "warning"); }
  }

  let active: { file: string; ctx: ExtensionContext; manager: AgentManager; pending: Set<string>; timer: NodeJS.Timeout; agents: AgentView[]; widget?: StatusWidget; fleet?: FleetView } | undefined;
  /** Paged transcript windows for this extension instance; cleared when monitoring stops. */
  const transcriptCache = new TranscriptCache();

  function pump(): void {
    if (!active || active.ctx.sessionManager.getSessionFile() !== active.file) return;
    try {
      active.agents = active.manager.list();
      deliverReports(active.manager, pi, active.ctx, active.pending, Date.now(), active.agents);
    }
    catch (error) { console.error("[pi-cli-subagents] Report delivery failed; retrying:", error); }
    try { active.widget?.update(); active.fleet?.update(); }
    catch (error) { console.error("[pi-cli-subagents] Status refresh failed; retrying:", error); }
  }
  function stopMonitor(): void {
    sessionEpoch++;
    dismissPanel?.(); dismissPanel = undefined;
    if (active) { clearInterval(active.timer); active.widget?.dispose(); active.fleet?.dispose(); }
    active = undefined;
    transcriptCache.clear();
  }
  pi.on("session_start", (_event, ctx) => {
    stopMonitor();
    const file = ctx.sessionManager.getSessionFile();
    if (!file) return;
    const manager = parentManager(ctx, launch);
    const pending = new Set<string>();
    const timer = setInterval(pump, 800);
    timer.unref();
    const monitor: NonNullable<typeof active> = { file, ctx, manager, pending, timer, agents: [] };
    // Both widgets render the monitor's snapshot; actions still re-read live state.
    if (ctx.mode === "tui") {
      monitor.widget = new StatusWidget(ctx.ui, () => monitor.agents);
      monitor.fleet = new FleetView(ctx.ui, () => monitor.agents, (id) => {
        void openAgents(ctx, id).finally(() => monitor.fleet?.viewerClosed());
        // The role editor keeps the editor on screen but owns the keyboard itself.
      }, () => panelBusy);
      // Start the CLI discovery now so `/cli-agents-setting` opens with its pickers already populated.
      cliAvailability = undefined; catalog = undefined; catalogProbe = undefined;
      discover(ctx.cwd);
    }
    active = monitor;
    setTimeout(pump, 100).unref();
  });
  pi.on("session_shutdown", () => stopMonitor());

  pi.registerTool({
    name: "create_workspace", label: "Create managed worktree",
    description: "Create a parent-owned detached Git worktree. Default: committed HEAD, reporting but not inheriting dirty files. Explicitly authorized includeUncommitted creates an internal baseline commit without updating the parent's HEAD, index or branches. One independently integrable change per workspace. No dependency installs, pushes or cleanup.",
    parameters: Type.Object({
      includeUncommitted: Type.Optional(Type.Object({ reason: Type.String({ description: "Why the user authorized inheriting ALL current uncommitted parent changes. Inspect them first; never assume unrelated edits belong to the task.", minLength: 1 }) })),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      return content(JSON.stringify(await parentManager(ctx, launch).workspaces.create(ctx.cwd, args)));
    },
  });
  pi.registerTool({
    name: "integrate_workspace", label: "Integrate managed worktree",
    description: "Apply an idle managed workspace's changes to its original parent directory without changing the index, HEAD or branches. Requires in-scope independent review. Includes untracked, non-ignored files; conflicts reject the entire patch before writing. Retains the worktree and patch. After deliberate continuation, integrates only the subsequent increment. Old instances must choose a baseline before resuming; unfinished operations require inspection, not blind retries.",
    parameters: Type.Object({ workspace: Type.String({ description: "Workspace ID returned by create_workspace" }) }),
    async execute(_id, args, _signal, _update, ctx) {
      return content(JSON.stringify(await parentManager(ctx, launch).workspaces.integrate(args.workspace)));
    },
  });
  pi.registerTool({
    name: "spawn_agent", label: "Spawn CLI subagent",
    description: "Start an independent, reusable Pi, Codex or Claude Code CLI subagent asynchronously. Returns an ID; keep working while completion reports arrive automatically. Roles: explore/worker/reviewer/oracle or custom roles. Reuse an existing instance with send_input when the new work depends on what it already did.",
    parameters: Type.Object({
      role: Type.String({ description: "Role name; use list_agents to discover available roles" }),
      task: Type.String({ description: "Concrete goal, authorized files and verification criteria; do not widen CLI permissions" }),
      cwd: Type.Optional(Type.String({ description: "Shared working directory; defaults to the parent directory. Cannot be combined with workspace." })),
      workspace: Type.Optional(Type.String({ description: "Managed workspace ID; worker and independent reviewer use the same ID, sequentially. Cannot be combined with cwd." })),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      const roles = loadRoles(getAgentDir(), ctx.cwd, ctx.isProjectTrusted());
      const resolved = roles[args.role];
      if (!resolved) throw new Error(`Unknown role: ${args.role}; available: ${Object.keys(roles).join(", ")}`);
      if (args.workspace !== undefined && args.cwd !== undefined) throw new Error("Pass workspace or cwd, not both");
      const role = inheritParentModel(resolved, ctx);
      const state = await parentManager(ctx, launch).spawn(args.role, role, args.cwd ?? ctx.cwd, args.task, args.workspace);
      return content(`${state.cli === "codex" ? "Codex" : state.cli === "claude" ? "Claude Code" : "Pi"} subagent dispatched: ${view(state)}\nThe parent may continue working. Completion and waiting reports return to this parent session.`);
    },
  });
  pi.registerTool({
    name: "send_input", label: "Message CLI subagent",
    description: "Send instructions to a running child (steer after its current tool; Pi-only followUp after the current run), or resume a completed child in its original session. Codex running followUp and Claude running steer/followUp are not supported; wait for completion before continuing Claude. Never silently creates a replacement session. Managed workspaces reject messages while another instance occupies them. After integration or another instance's sync, explicitly choose keep (current workspace unchanged) or sync (update to parent state only if no unintegrated/staged work). Sync never runs while the instance is active.",
    parameters: Type.Object({
      id: Type.String({ description: "Subagent instance ID" }),
      message: Type.String({ description: "Instructions or a new task for the same child" }),
      mode: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")], { description: "Delivery while running; defaults to steer" })),
      baseline: Type.Optional(Type.Union([Type.Literal("keep"), Type.Literal("sync")], { description: "Required after integration/baseline changes. keep preserves current workspace files, not the old session's remembered files. sync safely updates an idle, fully integrated workspace." })),
      includeUncommitted: Type.Optional(Type.Object({ reason: Type.String({ description: "For sync only: why the user authorized inheriting ALL current uncommitted parent changes. Inspect first; unrelated changes require confirmation.", minLength: 1 }) })),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      const state = await parentManager(ctx, launch).send(args.id, args.message, (args.mode ?? "steer") as Delivery,
        { baseline: args.baseline, includeUncommitted: args.includeUncommitted });
      return content(`Message accepted; wait for the final report: ${view(state)}`);
    },
  });
  pi.registerTool({
    name: "list_agents", label: "List CLI subagents",
    description: "Inspect this parent's instances, task history, roles and pending requests; do not poll for completion. Without id, lists metadata only. With id, includes the current result preview (not full text). With id + runId, reads a page of that run's original final result instead; keep both IDs fixed and follow nextOffset until null to read it all. Never accesses another parent session or resumes an agent.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Subagent instance ID; required with runId" })),
      runId: Type.Optional(Type.String({ description: "Read this exact run's final result, not the current instance preview" })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Result offset in UTF-16 code units (default 0); requires id + runId. Use the returned nextOffset." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 6000, description: "Result page size in UTF-16 code units (default/max 6000); requires id + runId" })),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      const manager = parentManager(ctx, launch);
      if (args.runId !== undefined) {
        if (!args.id) throw new Error("Reading a run result requires id + runId");
        const offset = args.offset ?? 0, limit = args.limit ?? 6000;
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Result offset must be a non-negative integer");
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 6000) throw new Error("Result limit must be an integer from 1 to 6000");
        const report = manager.getResult(args.id, args.runId);
        if (offset > report.text.length) throw new Error("Result offset exceeds totalLength");
        const end = Math.min(report.text.length, offset + limit);
        return content(JSON.stringify({ agentId: report.agentId, runId: report.runId, status: report.status, time: report.time,
          error: report.error, offset, totalLength: report.text.length, nextOffset: end < report.text.length ? end : null,
          text: report.text.slice(offset, end) }));
      }
      if (args.offset !== undefined || args.limit !== undefined) throw new Error("Result paging requires id + runId");
      const roles = loadRoles(getAgentDir(), ctx.cwd, ctx.isProjectTrusted());
      return content(JSON.stringify({ roles: Object.fromEntries(Object.entries(roles).map(([name, role]) => [name, role.description])),
        agents: (args.id !== undefined ? [manager.get(args.id)] : manager.list()).map(state => visible(state, args.id !== undefined)), workspaces: await manager.workspaces.list() }));
    },
  });
  pi.registerTool({
    name: "close_agent", label: "Stop CLI subagent",
    description: "Stop active work but retain the native session and identity for later send_input. Does not delete history.",
    parameters: Type.Object({ id: Type.String({ description: "Subagent instance ID" }) }),
    async execute(_id, args, _signal, _update, ctx) {
      return content(`Processes stopped; original session retained: ${view(await parentManager(ctx, launch).close(args.id))}`);
    },
  });

  pi.registerTool({
    name: "respond_to_permission", label: "Answer child interaction",
    description: "Answer one current request from a child owned by this parent. Compare the requested operation with the user's task authorization; approve only within scope, otherwise deny/cancel or ask the user. A humanOnly request cannot be approved by this tool: ask the human UI, or deny/cancel. This does not change global permissions or disable safety extensions. Every decision is recorded locally.",
    parameters: Type.Object({
      id: Type.String({ description: "Subagent instance ID from list_agents" }),
      questionId: Type.String({ description: "Exact current interaction ID" }),
      confirmed: Type.Optional(Type.Boolean({ description: "For confirm: true to approve once, false to deny" })),
      value: Type.Optional(Type.String({ description: "For select: an exact offered option; for input/editor: response text" })),
      cancelled: Type.Optional(Type.Literal(true, { description: "Cancel this request rather than answer it" })),
      reason: Type.String({ description: "Why this decision is within the parent's authorization, or why it was denied/cancelled" }),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      const state = await parentManager(ctx, launch).reply(args.id, args.questionId,
        { confirmed: args.confirmed, value: args.value, cancelled: args.cancelled }, { actor: "parent", reason: args.reason });
      return content(`Response sent to the child's current interaction; delivery is not proof the action completed: ${view(state)}`);
    },
  });

  // The human entry point remains available when the parent cannot decide safely.
  const describeAnswer = (answer: { value?: string; confirmed?: boolean; cancelled?: boolean }): string => {
    if (answer.cancelled) return "cancelled";
    if (typeof answer.confirmed === "boolean") return answer.confirmed ? "approved once" : "denied";
    return `replied "${oneLine(answer.value, 200)}"`;
  };
  async function replyPrompt(ctx: ExtensionContext, manager: AgentManager, id: string, questionId: string): Promise<void> {
    if (!ctx.hasUI) throw new Error("Interaction requires a TUI or an RPC client with dialogs");
    const q: Question | undefined = manager.get(id).questions.find((entry) => entry.id === questionId);
    if (!q) throw new Error("This request has ended or does not belong to this session");
    let answer: { value?: string; confirmed?: boolean; cancelled?: boolean };
    if (q.method === "confirm") answer = { confirmed: await ctx.ui.confirm(q.title, q.message ?? "") };
    else if (q.method === "select") {
      const value = await ctx.ui.select(q.message ? `${q.title}\n\n${q.message}` : q.title, q.options ?? []);
      answer = value === undefined ? { cancelled: true } : { value };
    } else if (q.method === "editor") {
      const value = await ctx.ui.editor(q.title, q.prefill);
      answer = value === undefined ? { cancelled: true } : { value };
    } else {
      const value = await ctx.ui.input(q.title, q.placeholder);
      answer = value === undefined ? { cancelled: true } : { value };
    }
    await manager.reply(id, questionId, answer);
    recordHumanAction(ctx, manager.get(id), `Answered pending request ${questionId}: ${describeAnswer(answer)}.`);
    ctx.ui.notify(`Human response sent to subagent ${id}`, "info");
  }

  pi.registerCommand("agent-reply", {
    description: "Answer a child interaction: /agent-reply <agentId> <questionId>",
    handler: async (args, ctx) => {
      try {
        const [id, questionId] = args.trim().split(/\s+/);
        if (!id || !questionId) throw new Error("Usage: /agent-reply <agentId> <questionId>");
        await replyPrompt(ctx, parentManager(ctx, launch), id, questionId);
      } catch (error) { ctx.ui.notify((error as Error).message, "error"); }
    },
  });

  async function sendHuman(ctx: ExtensionContext, manager: AgentManager, id: string, message: string, epoch: number, action: string): Promise<AgentView | undefined> {
    let state: AgentView;
    let options: ResumeOptions = {};
    try { state = await manager.send(id, message); }
    catch (error) {
      if (!(error instanceof WorkspaceDecisionRequired) || error.decision !== "baseline") throw error;
      ctx.ui.notify(error.message, "warning");
      const choice = await ctx.ui.select("Choose workspace baseline", ["keep — current workspace, no parent sync", "sync — update workspace from parent"]);
      if (!choice || epoch !== sessionEpoch) return;
      options = { baseline: choice.startsWith("keep") ? "keep" : "sync", expectedRevision: error.workspace.revision };
      try { state = await manager.send(id, message, "steer", options); }
      catch (error) {
        if (!(error instanceof WorkspaceDecisionRequired) || error.decision !== "inherit") throw error;
        const confirmed = await ctx.ui.confirm("Inherit these uncommitted parent changes?", `${error.parentChanges.join("\n")}\n\nConfirm only if ALL these changes are authorized for this task. The parent index, HEAD and branches will not change.`);
        if (!confirmed || epoch !== sessionEpoch) return;
        options = { ...options, expectedParentTree: error.parentTree,
          includeUncommitted: { reason: "The human explicitly confirmed the displayed parent changes in the TUI." } };
        state = await manager.send(id, message, "steer", options);
      }
    }
    recordHumanAction(ctx, state, `${action}${options.baseline ? ` (workspace baseline: ${options.baseline})` : ""}`);
    return state;
  }

  let panelBusy = false;
  /** Widget slot for the role editor, rendered by Pi in the area just above the editor. */
  const ROLE_SETTINGS_KEY = "cli-subagents-role-settings";
  /** The roster uses the same slot, so both panes sit above the editor instead of over it. */
  const AGENTS_PANEL_KEY = "cli-subagents-agents";
  type PaneWidget = { terminal: { rows: number }; requestRender(): void };
  /** Discovered once per session and shared by every panel, so the pickers are ready when it opens. */
  let catalog: ModelCatalog | undefined;
  let catalogProbe: Promise<void> | undefined;
  let cliAvailability: ReturnType<typeof detectClis> | undefined;
  const discover = (cwd: string): void => {
    cliAvailability ??= detectClis();
    catalogProbe ??= probeCatalog({ pi: launch, cwd, available: cliAvailability }).then((found) => { catalog = found; });
  };
  async function openAgents(ctx: ExtensionContext, selectedId?: string): Promise<void> {
      // The roster is a widget above the editor, so it needs Pi's TUI layout and raw input.
      if (ctx.mode !== "tui") { ctx.ui.notify("The panel requires a TUI; use list_agents / send_input / close_agent or /agent-reply instead.", "error"); return; }
      // Keep one panel/action loop per extension instance so concurrent commands cannot compete for input.
      if (panelBusy) { ctx.ui.notify("The agent panel is already open or processing an action; wait or close it with Esc.", "warning"); return; }
      panelBusy = true;
      const epoch = sessionEpoch;
      const fromFleet = selectedId !== undefined;
      let panel: AgentsPanel | undefined;
      let widget: PaneWidget | undefined;
      // Unset while a host dialog or the conversation overlay owns the keyboard, so this listener
      // never swallows a dialog's input.
      let deliver: ((data: string) => void) | undefined;
      const refresh = () => widget?.requestRender();
      // Ctrl+C stays with Pi so the host can still interrupt while the roster is open.
      const stopInput = ctx.ui.onTerminalInput((data) => {
        if (!deliver || data === "\u0003") return undefined;
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
          let action: PanelAction | undefined;
          if (selectedId) { action = { kind: "view", id: selectedId }; selectedId = undefined; }
          else {
            let agents: AgentView[] = [];
            try { agents = manager.list(); }
            catch (error) { ctx.ui.notify((error as Error).message, "error"); return; }
            if (!agents.length) { ctx.ui.notify("No subagents in this session.", "info"); return; }
            action = await new Promise<PanelAction | undefined>((resolve) => {
              let settled = false;
              const done = (result: PanelAction | undefined) => { if (!settled) { settled = true; deliver = undefined; resolve(result); } };
              // Esc during shutdown must still release this loop.
              dismissPanel = () => done(undefined);
              panel = new AgentsPanel(agents, theme, done, { rows: () => paneRows(widget?.terminal.rows ?? 24, panel?.mode ?? "list"), frameColor });
              deliver = (data) => panel?.handleInput(data);
              refresh();
            });
            dismissPanel = undefined;
          }
          if (!action || epoch !== sessionEpoch) return;
          try {
            if (action.kind === "view") {
              const id = action.id;
              const selected = manager.get(id);
              // One paged window per instance: reuse it while this process has it, never scan history unprompted.
              const identity: TranscriptIdentity = { parentFile: manager.parentFile, agentId: id, cli: selected.cli ?? "pi",
                ...(selected.session?.cli === "codex" ? { nativeId: selected.session.threadId } : selected.session?.cli === "claude" ? { nativeId: selected.session.sessionId } : {}) };
              const lease = await transcriptCache.acquire(identity, manager.eventLogs(id),
                () => new TranscriptWindow(identity.cli, identity.nativeId));
              let viewer: ConversationViewer | undefined;
              try {
                action = await ctx.ui.custom<PanelAction | undefined>((tui, theme, keybindings, done) => {
                  dismissPanel = () => { viewer?.dispose(); done(undefined); };
                  const files = () => manager.eventLogs(id);
                  viewer = new ConversationViewer(tui, theme, done, async () => ({
                    agent: manager.get(id), ...await lease.window.open(files()),
                  }), { keybindings, markdownTheme: getMarkdownTheme(),
                    paging: { older: async (boundary) => ({ agent: manager.get(id), ...await lease.window.pageUp(files(), boundary) }),
                      newer: async (boundary) => ({ agent: manager.get(id), ...await lease.window.pageDown(files(), boundary) }),
                      latest: async () => ({ agent: manager.get(id), ...await lease.window.toTail(files()) }) },
                    onSend: async (message) => {
                      try { recordHumanAction(ctx, await manager.send(id, message), `Sent an instruction: "${oneLine(message, 400)}"`); }
                      catch (error) {
                        if (error instanceof WorkspaceDecisionRequired) return { kind: "message", id, resume: true, message };
                        throw error;
                      }
                    },
                    // Match Pi's input box: its border follows the main session's thinking level.
                    frameColor: (text) => ctx.ui.theme.getThinkingBorderColor(ctx.thinkingLevel ?? "off")(text) });
                  return viewer;
                }, { overlay: true, overlayOptions: { width: "96%", maxHeight: "100%", margin: 1 } });
              } finally { viewer?.dispose(); lease.release(); dismissPanel = undefined; }
              if (epoch !== sessionEpoch) return;
              if (!action || action.kind === "view") { if (fromFleet) return; continue; }
            }
            // Re-read state before acting: the list is a snapshot, not an authorization or lifecycle guarantee.
            const state = manager.get(action.id);
            if (action.kind === "reply") { await replyPrompt(ctx, manager, action.id, action.questionId); if (fromFleet) return; continue; }
            if (action.kind === "stop") {
              if (isTerminal(state.phase)) { ctx.ui.notify(`${state.role} has already ended; nothing to stop.`, "info"); continue; }
              const confirmed = await ctx.ui.confirm("Stop subagent?", `${state.role} ${action.id.slice(0, 8)}: stop active work. The native session and results remain available for later continuation.`);
              if (!confirmed || epoch !== sessionEpoch) continue;
              recordHumanAction(ctx, await manager.close(action.id), "Stopped active work; the original session and results remain available.");
              ctx.ui.notify("Processes stopped; original session retained.", "info");
              if (fromFleet) return;
              continue;
            }
            if (state.phase === "waiting") { ctx.ui.notify("This child has a pending interaction: use r, /agent-reply, or the parent permission tool.", "error"); continue; }
            const steerable = canSteer(state.phase);
            const message = action.message ?? await ctx.ui.editor(steerable ? `Message ${state.role}` : `Resume ${state.role} in the original session`, "");
            if (!message?.trim() || epoch !== sessionEpoch) continue;
            if (!steerable) ctx.ui.notify("Starting a new turn in the original session; this can take up to about 60 seconds...", "info");
            const sent = await sendHuman(ctx, manager, action.id, message, epoch,
              `${steerable ? "Sent an instruction" : "Resumed the original session with"}: "${oneLine(message, 400)}"`);
            if (!sent) { if (fromFleet) return; continue; }
            ctx.ui.notify(steerable ? "Instructions accepted; a completion report will follow." : "New turn accepted in the original session; a completion report will follow.", "info");
            if (fromFleet) return;
          } catch (error) { ctx.ui.notify((error as Error).message, "error"); if (fromFleet) return; }
        }
      } catch (error) { ctx.ui.notify((error as Error).message, "error"); }
      finally {
        panel = undefined; widget = undefined; deliver = undefined;
        stopInput();
        ctx.ui.setWidget(AGENTS_PANEL_KEY, undefined);
        dismissPanel = undefined; panelBusy = false;
      }
  }
  pi.registerCommand("agents", {
    description: "Manage subagents: view live conversations, results and errors, message, resume, reply or stop",
    handler: (_args, ctx) => openAgents(ctx),
  });

  async function openRoleSettings(ctx: ExtensionContext): Promise<void> {
    // The panel is a widget above the editor, so it needs Pi's TUI layout and raw input.
    if (ctx.mode !== "tui") { ctx.ui.notify("Role settings need the TUI; edit ~/.pi/agent/cli-subagents.roles.json or .pi/cli-subagents.roles.json directly.", "error"); return; }
    if (panelBusy) { ctx.ui.notify("Another panel is open; close it with Esc before editing roles.", "warning"); return; }
    panelBusy = true;
    const epoch = sessionEpoch;
    const agentDir = getAgentDir(), cwd = ctx.cwd, trusted = ctx.isProjectTrusted();
    let scope: Scope = trusted ? "project" : "user";
    const disk = {} as Record<Scope, Record<string, Role>>, draft = {} as Record<Scope, Record<string, Role>>;
    const dirty: Record<Scope, boolean> = { user: false, project: false };
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
    try {
      try {
        disk.user = readScope("user", agentDir, cwd);
        disk.project = trusted ? readScope("project", agentDir, cwd) : {};
      } catch (error) { ctx.ui.notify((error as Error).message, "error"); return; }
      draft.user = structuredClone(disk.user); draft.project = structuredClone(disk.project);
      // Reopening where the user left off: every action rebuilds the panel from current state.
      let cursor: RoleSettingsCursor = {};
      while (epoch === sessionEpoch) {
        const preview = mergeRoles([scope === "user" ? draft.user : disk.user, scope === "project" ? draft.project : disk.project]);
        const rows = roleRows(preview, draft.user, draft.project, scope);
        const action = await new Promise<RoleSettingsAction | undefined>((resolve) => {
          let settled = false;
          const done = (result: RoleSettingsAction | undefined) => { if (!settled) { settled = true; deliver = undefined; resolve(result); } };
          // A lower-screen pane: tall enough to be useful, never taller than a third of the terminal.
          panel = new RoleSettingsPanel(rows, scope, trusted, dirty[scope], theme, done,
            () => Math.max(6, Math.min(SETTINGS_MAX_ROWS + 4, Math.floor((widget?.terminal.rows ?? 24) / 3))),
            (text) => ctx.ui.theme.getThinkingBorderColor(ctx.thinkingLevel ?? "off")(text),
            () => ({ clis, ...(catalog ? { catalog } : {}), ...(catalog ? {} : { pending: true }) }), cursor);
          deliver = (data) => panel?.handleInput(data);
          refresh();
        });
        if (!action || epoch !== sessionEpoch) return;
        const label = scope === "user" ? "personal" : "project";
        try {
          if (action.kind === "close") {
            if (!dirty.user && !dirty.project) return;
            const discard = await ctx.ui.confirm("Discard unsaved role changes?", `Unsaved edits in: ${["user", "project"].filter((item): item is Scope => dirty[item as Scope]).map((item) => item === "user" ? "personal" : "project").join(", ")}. The files on disk are unchanged.`);
            if (epoch !== sessionEpoch) return;
            if (discard) return;
            continue;
          }
          // A different scope holds a different role set, so start it from the top.
          if (action.kind === "scope") { scope = action.scope; cursor = {}; continue; }
          if (action.kind === "save") {
            const file = writeScope(scope, agentDir, cwd, draft[scope]);
            disk[scope] = readScope(scope, agentDir, cwd); draft[scope] = structuredClone(disk[scope]); dirty[scope] = false;
            ctx.ui.notify(`Saved ${file}`, "info");
            continue;
          }
          if (action.kind === "set") {
            cursor = { role: action.role, field: action.field };
            const base = preview[action.role];
            if (!base) throw new Error(`Unknown role: ${action.role}`);
            draft[scope] = setField(draft[scope], action.role, base, action.field, action.value); dirty[scope] = true;
            continue;
          }
          if (action.kind === "edit") {
            // Kept even when the dialog is cancelled, so the same field stays under the cursor.
            cursor = { role: action.role, field: action.field };
            const base = preview[action.role];
            if (!base) throw new Error(`Unknown role: ${action.role}`);
            const field = action.field, role = draft[scope][action.role] ?? base;
            const value = field === "instructions" || field === "description"
              ? await ctx.ui.editor(`${field === "instructions" ? "Instructions" : "Description"} for ${action.role}`, fieldValue(role, field))
              : await ctx.ui.input(`${FIELD_LABELS[field]} for ${action.role}`, field === "model" ? "Exact model name or alias" : "", undefined);
            if (value === undefined || epoch !== sessionEpoch) continue;
            draft[scope] = setField(draft[scope], action.role, base, field, value); dirty[scope] = true;
            continue;
          }
          if (action.kind === "add") {
            const name = await ctx.ui.input("New role name", "lowercase, e.g. tester");
            if (name === undefined || epoch !== sessionEpoch) continue;
            const clean = name.trim();
            if (!/^[a-z][a-z0-9-]*$/.test(clean)) { ctx.ui.notify("Role names use lowercase letters, digits and dashes.", "error"); continue; }
            if (preview[clean]) { ctx.ui.notify(`Role ${clean} already exists; select it and press enter to customize it here.`, "warning"); continue; }
            draft[scope] = addRole(draft[scope], clean); dirty[scope] = true;
            cursor = { role: clean };   // the new role needs its description and instructions written
            continue;
          }
          if (action.kind === "remove") {
            const confirmed = await ctx.ui.confirm(`Remove ${action.role} from ${label} roles?`, "Lower-scope definitions apply again. Other scopes are untouched.");
            if (!confirmed || epoch !== sessionEpoch) continue;
            draft[scope] = deleteRole(draft[scope], action.role); dirty[scope] = true; cursor = {};
          }
        } catch (error) { ctx.ui.notify((error as Error).message, "error"); }
      }
    } finally {
      panel = undefined;
      widget = undefined;
      deliver = undefined;
      stopInput();
      ctx.ui.setWidget(ROLE_SETTINGS_KEY, undefined);
      panelBusy = false;
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
