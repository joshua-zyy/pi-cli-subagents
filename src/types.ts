export type Phase = "starting" | "running" | "waiting" | "stopping" | "completed" | "failed" | "stopped" | "unreachable";
export type Delivery = "steer" | "followUp";
export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface Role {
  description: string;
  instructions: string;
  provider?: string;
  model?: string;
  thinking?: Thinking;
}

// An argv launch, not a shell command. Injectable for protocol tests.
export interface Launch { command: string; args: string[] }
export interface AgentSpec {
  version: 1;
  id: string;
  parentFile: string;
  cwd: string;
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
}
export interface SessionHandle { sessionId: string; sessionFile: string }
export interface AgentState extends Partial<SessionHandle> {
  id: string;
  runId: string;
  phase: Phase;
  workerPid: number;
  cliPid?: number;
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
export interface StartRequest { runId: string; message: string; session?: SessionHandle }
export interface Endpoint { port: number; token: string; runId: string }
export interface Report {
  notificationId: string;
  agentId: string;
  runId: string;
  parentFile: string;
  status: "completed" | "failed" | "stopped" | "waiting";
  time: number;
  text: string;
  error?: string;
  questionId?: string;
  resultFile?: string;
  logFile: string;
}
export interface AgentView extends AgentState {
  role: string;
  cwd: string;
  text?: string;
  truncated?: boolean;
}
export type Control =
  | { type: "status" }
  | { type: "send"; message: string; mode: Delivery }
  | { type: "close" }
  | { type: "reply"; id: string; value?: string; confirmed?: boolean; cancelled?: boolean };
