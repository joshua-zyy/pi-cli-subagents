import type { Exit } from "./pi-process.js";
import type { AgentSpec, Control, Delivery, NativeSession, Question, SessionHandle } from "./types.js";

export type AdapterEvent =
  | { type: "activity"; detail: string }
  | { type: "question"; question: Question }
  | { type: "resolved"; id: string }
  | { type: "settled"; status: "completed" | "failed" | "stopped"; text: string; error?: string; stop?: boolean };
export type InteractionReply = Extract<Control, { type: "reply" }>;
export interface AdapterOptions {
  spec: AgentSpec;
  session?: NativeSession;
  logFile: string;
  onEvent: (event: AdapterEvent) => void;
  /** Injectable deadline for deterministic transport tests, not a role setting. */
  requestTimeout?: number;
}

/** Native protocol details stay here; ownership, audit and reports stay in the worker. */
export interface CliAdapter {
  readonly pid: number | undefined;
  readonly closed: Promise<Exit>;
  ready(): Promise<NativeSession>;
  start(message: string): Promise<void>;
  send(message: string, mode: Delivery): Promise<void>;
  reply(answer: InteractionReply): Promise<void>;
  end(): Promise<{ exit: Exit; forced: boolean }>;
  stop(): Promise<{ exit: Exit; forced: boolean }>;
}

export function nativeSession(session: NativeSession | SessionHandle | undefined): NativeSession | undefined {
  if (!session) return undefined;
  return "cli" in session ? session : { cli: "pi", ...session };
}
