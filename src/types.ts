export type Phase = "starting" | "running" | "waiting" | "stopping" | "completed" | "failed" | "stopped" | "unreachable";
export type Delivery = "steer" | "followUp";
export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type Cli = "pi" | "codex" | "claude";
export type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface Role {
  cli?: Cli;
  effort?: Effort;
  description: string;
  instructions: string;
  provider?: string;
  model?: string;
  thinking?: Thinking;
}

// An argv launch, not a shell command. Injectable for protocol tests.
export interface Launch { command: string; args: string[] }
export interface AgentSpec {
  version: 1 | 2 | 3;
  /** Missing only in legacy Pi records. Backend selection is immutable per instance. */
  cli?: Cli;
  /** Resolved once at creation; never switch native stores on continuation. */
  codexHome?: string;
  claudeHome?: string;
  id: string;
  parentFile: string;
  cwd: string;
  /** Parent-owned managed workspace; absent for shared-directory instances. */
  workspace?: string;
  /** The code baseline explicitly delivered to this native session. */
  workspaceBaseline?: { commit: string; revision: number };
  roleName: string;
  role: Role;
  launch: Launch;
  createdAt: number;
}
export interface Question {
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  expiresAt?: number;
  /** Native policy requires a human for approval; parent denial/cancellation remains safe. */
  humanOnly?: boolean;
}
/** Legacy Pi fields remain readable, including pre-adapter request/state records. */
export interface SessionHandle { sessionId: string; sessionFile: string }
export type NativeSession =
  | ({ cli: "pi" } & SessionHandle)
  | { cli: "codex"; threadId: string; sessionId: string; codexHome: string }
  | { cli: "claude"; sessionId: string; claudeHome: string };
/**
 * One assignment this instance has already been given. It answers "what did this instance do"
 * after the parent's own context is compacted, without replaying the child's transcript.
 */
export interface TaskRun {
  runId: string;
  startedAt: number;
  task?: string;
  /** Reported outcome, the live phase of the current run, or `unknown` when a run left no report. */
  status: Phase | "unknown";
}
export interface AgentState extends Partial<SessionHandle> {
  session?: NativeSession;
  id: string;
  runId: string;
  phase: Phase;
  workerPid: number;
  cliPid?: number;
  /** Start time of this run; old records fall back to updatedAt. */
  startedAt?: number;
  updatedAt: number;
  accepted: boolean;
  questions: Question[];
  lastActivity?: string;
  error?: string;
  resultFile?: string;
  logFile: string;
  exitCode?: number | null;
  forced?: boolean;
}
export interface StartRequest { runId: string; message: string; session?: NativeSession | SessionHandle; createdAt?: number }
export interface Endpoint { port: number; token: string; runId: string }
export interface Report {
  notificationId: string;
  agentId: string;
  runId: string;
  parentFile: string;
  status: "completed" | "failed" | "stopped" | "waiting" | "stalled";
  time: number;
  text: string;
  error?: string;
  questionId?: string;
  resultFile?: string;
  logFile: string;
}
export interface AgentView extends AgentState {
  cli?: Cli;
  role: string;
  cwd: string;
  workspace?: string;
  workspaceBaseline?: AgentSpec["workspaceBaseline"];
  /** Optional one-line summary of the current run's task. */
  task?: string;
  /** Most recent assignments and total count; absent when an inventory record is unreadable. */
  history?: TaskRun[];
  runCount?: number;
  text?: string;
  truncated?: boolean;
}
export type Control =
  | { type: "status" }
  | { type: "send"; message: string; mode: Delivery }
  | { type: "close" }
  | { type: "reply"; id: string; value?: string; confirmed?: boolean; cancelled?: boolean; actor?: "human" | "parent"; reason?: string };
