import { Type } from "@earendil-works/pi-ai";
import { Key } from "@earendil-works/pi-tui";
import { getAgentDir, getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "./manager.js";
import { deliverReports } from "./notifier.js";
import { loadRoles } from "./roles.js";
import { AgentsPanel, type PanelAction } from "./ui/panel.js";
import { canSteer, isTerminal } from "./ui/format.js";
import { StatusWidget } from "./ui/status.js";
import { FleetView } from "./ui/fleet.js";
import { TranscriptReader } from "./ui/transcript.js";
import { ConversationViewer } from "./ui/conversation.js";
import type { AgentView, Delivery, Launch, Question } from "./types.js";

export function parentManager(ctx: Pick<ExtensionContext, "sessionManager">, launch: Launch): AgentManager {
  const parentFile = ctx.sessionManager.getSessionFile();
  if (!parentFile) throw new Error("A persistent parent session is required (do not use --no-session) to route and replay child reports.");
  return new AgentManager(parentFile, launch);
}

function visible(state: AgentView) {
  const { id, role, phase, runId, sessionId, cwd, updatedAt, lastActivity, questions, text, truncated, error, logFile } = state;
  return { id, role, phase, runId, sessionId, cwd, updatedAt, lastActivity, questions, text, truncated, error, logFile };
}
const view = (state: AgentView): string => JSON.stringify(visible(state));
const content = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });

export default function extension(pi: ExtensionAPI): void {
  // Explicit child marker prevents an auto-discovered copy of this extension from recursively spawning agents.
  if (process.env.PI_CLI_SUBAGENT === "1") return;
  const cli = process.argv[1];
  const launch: Launch = { command: process.execPath, args: [cli] };
  let dismissPanel: (() => void) | undefined;
  let sessionEpoch = 0;
  let active: { file: string; ctx: ExtensionContext; manager: AgentManager; pending: Set<string>; timer: NodeJS.Timeout; widget?: StatusWidget; fleet?: FleetView } | undefined;

  function pump(): void {
    if (!active || active.ctx.sessionManager.getSessionFile() !== active.file) return;
    try { deliverReports(active.manager, pi, active.ctx, active.pending); }
    catch (error) { console.error("[pi-cli-subagents] Report delivery failed; retrying:", error); }
    try { active.widget?.update(); active.fleet?.update(); }
    catch (error) { console.error("[pi-cli-subagents] Status refresh failed; retrying:", error); }
  }
  function stopMonitor(): void {
    sessionEpoch++;
    dismissPanel?.(); dismissPanel = undefined;
    if (active) { clearInterval(active.timer); active.widget?.dispose(); active.fleet?.dispose(); }
    active = undefined;
  }
  pi.on("session_start", (_event, ctx) => {
    stopMonitor();
    const file = ctx.sessionManager.getSessionFile();
    if (!file) return;
    const manager = parentManager(ctx, launch);
    const pending = new Set<string>();
    const timer = setInterval(pump, 800);
    timer.unref();
    // The widget needs terminal components and requestRender; RPC clients cannot render it.
    const widget = ctx.mode === "tui" ? new StatusWidget(ctx.ui, () => manager.list()) : undefined;
    let fleet: FleetView | undefined;
    if (ctx.mode === "tui") fleet = new FleetView(ctx.ui, () => manager.list(), (id) => {
      void openAgents(ctx, id).finally(() => fleet?.viewerClosed());
    });
    active = { file, ctx, manager, pending, timer, ...(widget ? { widget } : {}), ...(fleet ? { fleet } : {}) };
    setTimeout(pump, 100).unref();
  });
  pi.on("session_shutdown", () => stopMonitor());

  pi.registerTool({
    name: "spawn_agent", label: "Spawn Pi subagent",
    description: "Start an independent, reusable Pi CLI subagent asynchronously. Returns an ID; keep working while completion reports arrive automatically. Roles: worker/reviewer or custom roles.",
    parameters: Type.Object({
      role: Type.String({ description: "Role name; use list_agents to discover available roles" }),
      task: Type.String({ description: "Concrete goal, authorized files and verification criteria; do not widen CLI permissions" }),
      cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the parent directory" })),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      const roles = loadRoles(getAgentDir(), ctx.cwd, ctx.isProjectTrusted());
      const role = roles[args.role];
      if (!role) throw new Error(`Unknown role: ${args.role}; available: ${Object.keys(roles).join(", ")}`);
      const state = await parentManager(ctx, launch).spawn(args.role, role, args.cwd ?? ctx.cwd, args.task);
      return content(`Pi subagent dispatched: ${view(state)}\nThe parent may continue working. Completion and waiting reports return to this parent session.`);
    },
  });
  pi.registerTool({
    name: "send_input", label: "Message Pi subagent",
    description: "Send instructions to a running child (steer after its current tool, followUp after the current run), or resume a completed child in its original session. Never silently creates a replacement session.",
    parameters: Type.Object({
      id: Type.String({ description: "Subagent instance ID" }),
      message: Type.String({ description: "Instructions or a new task for the same child" }),
      mode: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")], { description: "Delivery while running; defaults to steer" })),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      const state = await parentManager(ctx, launch).send(args.id, args.message, (args.mode ?? "steer") as Delivery);
      return content(`Message accepted; wait for the final report: ${view(state)}`);
    },
  });
  pi.registerTool({
    name: "list_agents", label: "List Pi subagents",
    description: "List this parent's subagent instances, their states and available roles. Does not access other parent sessions.",
    parameters: Type.Object({ id: Type.Optional(Type.String({ description: "If provided, return only this instance" })) }),
    async execute(_id, args, _signal, _update, ctx) {
      const roles = loadRoles(getAgentDir(), ctx.cwd, ctx.isProjectTrusted());
      const manager = parentManager(ctx, launch);
      return content(JSON.stringify({ roles: Object.fromEntries(Object.entries(roles).map(([name, role]) => [name, role.description])),
        agents: (args.id ? [manager.get(args.id)] : manager.list()).map(visible) }));
    },
  });
  pi.registerTool({
    name: "close_agent", label: "Stop Pi subagent",
    description: "Stop active work but retain the native Pi session and identity for later send_input. Does not delete history.",
    parameters: Type.Object({ id: Type.String({ description: "Subagent instance ID" }) }),
    async execute(_id, args, _signal, _update, ctx) {
      return content(`Processes stopped; original session retained: ${view(await parentManager(ctx, launch).close(args.id))}`);
    },
  });

  pi.registerTool({
    name: "list_pending_permissions", label: "List pending child interactions",
    description: "List unresolved interactions from this parent's Pi subagents. Inspect the request and the original task before deciding; do not assume every request is safe to approve.",
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      const pending = parentManager(ctx, launch).list().filter((agent) => agent.questions.length && agent.phase === "waiting")
        .map(({ id, role, cwd, task, runId, questions }) => ({ id, role, cwd, task, runId, questions }));
      return content(JSON.stringify(pending));
    },
  });
  pi.registerTool({
    name: "respond_to_permission", label: "Answer child interaction",
    description: "Answer one current request from a child owned by this parent. Compare the requested operation with the user's task authorization; approve only within scope, otherwise deny/cancel or ask the user. This does not change global permissions or disable safety extensions. Every decision is recorded locally.",
    parameters: Type.Object({
      id: Type.String({ description: "Subagent instance ID returned by list_pending_permissions" }),
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
  async function replyPrompt(ctx: ExtensionContext, manager: AgentManager, id: string, questionId: string): Promise<void> {
    if (!ctx.hasUI) throw new Error("Interaction requires a TUI or an RPC client with dialogs");
    const q: Question | undefined = manager.get(id).questions.find((entry) => entry.id === questionId);
    if (!q) throw new Error("This request has ended or does not belong to this session");
    let answer: { value?: string; confirmed?: boolean; cancelled?: boolean };
    if (q.method === "confirm") answer = { confirmed: await ctx.ui.confirm(q.title, q.message ?? "") };
    else if (q.method === "select") {
      const value = await ctx.ui.select(q.title, q.options ?? []);
      answer = value === undefined ? { cancelled: true } : { value };
    } else if (q.method === "editor") {
      const value = await ctx.ui.editor(q.title, q.prefill);
      answer = value === undefined ? { cancelled: true } : { value };
    } else {
      const value = await ctx.ui.input(q.title, q.placeholder);
      answer = value === undefined ? { cancelled: true } : { value };
    }
    await manager.reply(id, questionId, answer);
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

  let panelBusy = false;
  async function openAgents(ctx: ExtensionContext, selectedId?: string): Promise<void> {
      // custom() returns undefined in RPC mode; terminal panels are TUI-only.
      if (ctx.mode !== "tui") { ctx.ui.notify("The panel requires a TUI; use list_agents / send_input / close_agent or /agent-reply instead.", "error"); return; }
      // Keep one panel/action loop per extension instance so concurrent commands cannot compete for input.
      if (panelBusy) { ctx.ui.notify("The agent panel is already open or processing an action; wait or close it with Esc.", "warning"); return; }
      panelBusy = true;
      const epoch = sessionEpoch;
      const fromFleet = selectedId !== undefined;
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
            // Close the overlay before opening action dialogs; the next loop restores the list.
            action = await ctx.ui.custom<PanelAction | undefined>((tui, theme, _kb, done) => {
              dismissPanel = () => done(undefined);
              return new AgentsPanel(agents, theme, done, { rows: () => Math.max(1, tui.terminal.rows - 2) });
            }, { overlay: true, overlayOptions: { width: "96%", maxHeight: "100%", margin: 1 } });
            dismissPanel = undefined;
          }
          if (!action || epoch !== sessionEpoch) return;
          try {
            if (action.kind === "view") {
              const id = action.id;
              const reader = new TranscriptReader();
              let viewer: ConversationViewer | undefined;
              try {
                action = await ctx.ui.custom<PanelAction | undefined>((tui, theme, keybindings, done) => {
                  dismissPanel = () => { viewer?.dispose(); done(undefined); };
                  viewer = new ConversationViewer(tui, theme, done, async () => {
                    const agent = manager.get(id);
                    return { agent, ...await reader.read(manager.eventLogs(id)) };
                  }, { keybindings, markdownTheme: getMarkdownTheme() });
                  return viewer;
                }, { overlay: true, overlayOptions: { width: "96%", maxHeight: "100%", margin: 1 } });
              } finally { viewer?.dispose(); dismissPanel = undefined; }
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
              await manager.close(action.id);
              ctx.ui.notify("Processes stopped; original session retained.", "info");
              if (fromFleet) return;
              continue;
            }
            if (state.phase === "waiting") { ctx.ui.notify("This child has a pending interaction: use r, /agent-reply, or the parent permission tool.", "error"); continue; }
            const steerable = canSteer(state.phase);
            const message = await ctx.ui.editor(steerable ? `Message ${state.role}` : `Resume ${state.role} in the original session`, "");
            if (!message?.trim() || epoch !== sessionEpoch) continue;
            if (!steerable) ctx.ui.notify("Starting a new turn in the original session; this can take up to about 60 seconds...", "info");
            await manager.send(action.id, message);
            ctx.ui.notify(steerable ? "Instructions accepted; a completion report will follow." : "New turn accepted in the original session; a completion report will follow.", "info");
            if (fromFleet) return;
          } catch (error) { ctx.ui.notify((error as Error).message, "error"); if (fromFleet) return; }
        }
      } catch (error) { ctx.ui.notify((error as Error).message, "error"); }
      finally { dismissPanel = undefined; panelBusy = false; }
  }
  pi.registerCommand("agents", {
    description: "Manage subagents: view live conversations, results and errors, message, resume, reply or stop",
    handler: (_args, ctx) => openAgents(ctx),
  });
  pi.registerShortcut(Key.ctrlAlt("a"), {
    description: "Open the subagent roster while the parent is working",
    handler: openAgents,
  });
}
