export type Phase = "starting" | "running" | "waiting" | "stopping" | "completed" | "failed" | "stopped" | "idle" | "closed" | "unreachable";
export type Delivery = "steer" | "followUp";
export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type Cli = "pi" | "codex" | "claude";
/**
 * The Codex app-server defines effort as "a non-empty reasoning effort value advertised by the
 * model", so this stays open: the model's own catalog decides, not a list this plugin maintains.
 */
export type Effort = string;

/** Native Claude Code `--permission-mode` levels, as accepted by 2.1.283. */
export type ClaudeMode = "acceptEdits" | "auto" | "manual" | "dontAsk" | "plan" | "bypassPermissions";
/** Codex presets; each names one (approvalPolicy, sandbox) pair rather than two free axes. */
export type CodexMode = "read-only" | "workspace-write" | "full-access";
export type Mode = ClaudeMode | CodexMode;

/** Native tool trimming: Pi supports allow/deny, Claude supports deny only, Codex rejects both. */
export interface RoleToolTrim {
  allow?: string[];
  deny?: string[];
}
export interface Role {
  cli?: Cli;
  effort?: Effort;
  description: string;
  instructions: string;
  provider?: string;
  model?: string;
  thinking?: Thinking;
  /** Native permission posture for this role's launches; only Claude and Codex expose one. */
  mode?: Mode;
  /** Codex experimental Default-mode question gate; omitted inherits native config, not permissions. */
  defaultModeQuestions?: boolean;
  /** Pi allow/deny lists or Claude's deny list; Codex has no tool trimming switch. */
  tools?: RoleToolTrim;
  /** false disables skill discovery; a path list loads only those skills. Pi only, other backends reject it. */
  skills?: boolean | string[];
  /** false disables MCP for this Pi role; other backends have no switch and reject it. */
  mcp?: boolean;
  /** Omitted or false disables delegation; true is supported only by Codex and Claude. */
  allowSubagents?: boolean;
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
export interface QuestionField {
  id: string;
  header: string;
  question: string;
  /** Native hints, including text/number constraints; displayed without selecting a default. */
  description?: string;
  options: { label: string; description: string; preview?: string }[];
  /** Explicit false limits a field to one answer; omitted preserves the older Codex contract. */
  multiSelect?: boolean;
  /** Complete async-message answers require one non-blank string; ordinary forms may skip. */
  required?: true;
  allowOther: boolean;
  isSecret: boolean;
}
export type QuestionAnswers = Record<string, string[]>;
export interface Question {
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "form";
  /** Present only for a recognized native task-question form. */
  fields?: QuestionField[];
  /** Absent means blocking for legacy/native permission dialogs. */
  isBlocking?: boolean;
  /** Set only for a recognized, call-correlated task-question contract. */
  kind?: "question";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  expiresAt?: number;
  /** Reserved for requests a human must answer; no backend derives it from native policy signals (port plan §8.4). */
  humanOnly?: boolean;
  /**
   * Supported parent response shapes, not proof of user authorization or single-action effects.
   * Pi dialogs expose their native choices; the parent judges scope and user-required escalation.
   * Absent policy preserves legacy refusal-only behavior (`cancelled`, or `confirmed: false`).
   * `text` permits input/editor text and custom answers for recognized logical question selects.
   * `answers` permits a scoped Codex or Claude task form, not native MCP approval forms. An explicit
   * `humanOnly` flag remains binding; the parent must not invent or broaden authorization.
   */
  parentPolicy?: { values?: string[]; confirm?: boolean; text?: true; answers?: true };
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
  /** v2 runtime identity is independent of the currently assigned run. */
  protocolVersion?: 2;
  runtimeId?: string;
  /** Closed snapshots keep a legacy terminal phase on disk for downgrade readers. */
  runtimeClosed?: boolean;
  lastStatus?: "completed" | "failed" | "stopped";
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
export interface StartRequest { runId: string; message: string; session?: NativeSession | SessionHandle; createdAt?: number; logFile?: string }
export interface Endpoint { port: number; token: string; runId: string; protocolVersion?: 2; runtimeId?: string; preserveAccepted?: true }
/** The interaction a waiting report is about, so the notifier can state it without re-reading state. */
export type PendingRequest = Pick<Question, "method" | "options" | "parentPolicy" | "humanOnly" | "kind" | "fields" | "isBlocking">;
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
  /** Set for a waiting report while its request is still pending. */
  request?: PendingRequest;
  resultFile?: string;
  logFile: string;
}
/** Evidence for this operation response only; never persisted in state or reports. */
export interface OperationReceipt {
  operation: "start" | "send" | "interrupt" | "stop" | "reclaim";
  status: "accepted" | "queued" | "unconfirmed" | "settled" | "released" | "not_running" | "reclaimed";
  runId: string;
  runtimeId?: string;
  /** reclaim only: both dimensions no longer count this runtime. */
  accounting?: { active: boolean; resident: boolean };
  /** reclaim only: what was observed, by which criterion, so the claim is auditable. */
  evidence?: ReclaimEvidence;
  /** reclaim only: always false — a reclaim is a parent-side accounting claim, not a native release. */
  nativeReleaseConfirmed?: false;
  /** reclaim only: the instance is not resumable in this version, even though nothing was released natively. */
  continuation?: "blocked";
}

/** Absence is only claimed on an explicit OS answer; unknown, invalid and query failures are not absence. */
export interface ReclaimEvidence {
  worker: { pid: number; absent: true; criterion: "ESRCH" };
  cli: { pid: number; absent: true; criterion: "ESRCH" };
}

/**
 * A parent-side accounting reclaim for exactly one runtime. It is written once, kept next to the
 * runtime it names, and never replaces the worker's own execution state.
 */
export interface ReclaimRecord {
  version: 1;
  parentFile: string;
  id: string;
  runtimeId: string;
  observedAt: number;
  evidence: ReclaimEvidence;
  nativeReleaseConfirmed: false;
  continuation: "blocked";
}
export type ControlResult = AgentState & { receipt?: OperationReceipt };
export interface AgentView extends AgentState {
  receipt?: OperationReceipt;
  /** A valid reclaim names this instance's current runtime: its accounting no longer counts. */
  reclaimed?: { at: number; evidence: ReclaimEvidence; nativeReleaseConfirmed: false; continuation: "blocked" };
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
  | { type: "start"; message: string }
  | { type: "interrupt" }
  | { type: "close"; onlyIdle?: boolean; preserveAccepted?: boolean }
  | { type: "reply"; id: string; value?: string; answers?: QuestionAnswers; confirmed?: boolean; cancelled?: boolean; actor?: "human" | "parent"; reason?: string };
