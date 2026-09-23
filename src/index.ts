import { Type } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "./manager.js";
import { deliverReports } from "./notifier.js";
import { loadRoles } from "./roles.js";
import type { AgentView, Delivery, Launch, Question } from "./types.js";

export function parentManager(ctx: Pick<ExtensionContext, "sessionManager">, launch: Launch): AgentManager {
  const parentFile = ctx.sessionManager.getSessionFile();
  if (!parentFile) throw new Error("需要持久主会话（不能使用 --no-session），否则无法保证子代理结果归属和补交。 ");
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
  let active: { file: string; ctx: ExtensionContext; manager: AgentManager; pending: Set<string>; timer: NodeJS.Timeout } | undefined;

  function pump(): void {
    if (!active || active.ctx.sessionManager.getSessionFile() !== active.file) return;
    try { deliverReports(active.manager, pi, active.ctx, active.pending); }
    catch (error) { console.error("[pi-cli-subagents] 通知交付失败，稍后重试：", error); }
  }
  function stopMonitor(): void {
    if (active) clearInterval(active.timer);
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
    active = { file, ctx, manager, pending, timer };
    setTimeout(pump, 100).unref();
  });
  pi.on("session_shutdown", () => stopMonitor());

  pi.registerTool({
    name: "spawn_agent", label: "Spawn Pi subagent",
    description: "异步启动独立、可续聊的 Pi CLI 子代理。返回实例 ID；主 agent 可继续工作，完成会自动回报。角色：worker/reviewer 或自定义角色。",
    parameters: Type.Object({
      role: Type.String({ description: "角色名；用 list_agents 查看可用角色" }),
      task: Type.String({ description: "清晰的目标、范围、验收标准；勿在这里扩大 CLI 权限" }),
      cwd: Type.Optional(Type.String({ description: "要操作的目录；省略则与主 Pi 相同" })),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      const roles = loadRoles(getAgentDir(), ctx.cwd, ctx.isProjectTrusted());
      const role = roles[args.role];
      if (!role) throw new Error(`未知角色：${args.role}；可用角色：${Object.keys(roles).join(", ")}`);
      const state = await parentManager(ctx, launch).spawn(args.role, role, args.cwd ?? ctx.cwd, args.task);
      return content(`已派发 Pi 子代理：${view(state)}\n主 agent 可继续工作；完成或等待处理时会向本主会话汇报。`);
    },
  });
  pi.registerTool({
    name: "send_input", label: "Message Pi subagent",
    description: "给正在运行的子代理追加指令（steer 在当前工具结束后交付；followUp 等当前任务结束）；已完成的子代理则在原 session 续聊。不会暗中创建替代会话。",
    parameters: Type.Object({
      id: Type.String({ description: "子代理实例 ID" }),
      message: Type.String({ description: "追加内容或新一轮任务" }),
      mode: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")], { description: "运行中如何交付；默认 steer" })),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      const state = await parentManager(ctx, launch).send(args.id, args.message, (args.mode ?? "steer") as Delivery);
      return content(`消息已受理；查看最终结果仍需等待回报：${view(state)}`);
    },
  });
  pi.registerTool({
    name: "list_agents", label: "List Pi subagents",
    description: "列出本主会话创建的子代理、状态及可用角色；结果只属于当前主会话。",
    parameters: Type.Object({ id: Type.Optional(Type.String({ description: "若给出，则只查看这个子代理" })) }),
    async execute(_id, args, _signal, _update, ctx) {
      const roles = loadRoles(getAgentDir(), ctx.cwd, ctx.isProjectTrusted());
      const manager = parentManager(ctx, launch);
      return content(JSON.stringify({ roles: Object.fromEntries(Object.entries(roles).map(([name, role]) => [name, role.description])),
        agents: (args.id ? [manager.get(args.id)] : manager.list()).map(visible) }));
    },
  });
  pi.registerTool({
    name: "close_agent", label: "Stop Pi subagent",
    description: "停止正在运行的任务；保留原生 Pi 会话和身份，之后可以继续 send_input。不会删除历史。",
    parameters: Type.Object({ id: Type.String({ description: "子代理实例 ID" }) }),
    async execute(_id, args, _signal, _update, ctx) {
      return content(`已关闭运行进程，原 session 保留：${view(await parentManager(ctx, launch).close(args.id))}`);
    },
  });

  // Human-only. The LLM has no reply/approval tool; all answers are explicitly initiated by the user.
  pi.registerCommand("agent-reply", {
    description: "人工处理子 Pi 的权限/交互请求：/agent-reply <agentId> <questionId>",
    handler: async (args, ctx) => {
      try {
        const [id, questionId] = args.trim().split(/\s+/);
        if (!id || !questionId) throw new Error("用法：/agent-reply <agentId> <questionId>");
        if (!ctx.hasUI) throw new Error("当前模式不支持人工交互；请在 TUI 或有对话框的 RPC 客户端中处理");
        const manager = parentManager(ctx, launch);
        const q: Question | undefined = manager.get(id).questions.find((entry) => entry.id === questionId);
        if (!q) throw new Error("请求已经结束或不属于此会话");
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
        ctx.ui.notify(`已向子代理 ${id} 提交人工答复`, "info");
      } catch (error) { ctx.ui.notify((error as Error).message, "error"); }
    },
  });
}
