import type { Exit } from "./pi-process.js";
import type { AgentSpec, Control, Delivery, NativeSession, Question, SessionHandle } from "./types.js";

export type AdapterEvent =
  | { type: "activity"; detail: string; runId?: string }
  | { type: "question"; question: Question; runId?: string; runtimeScoped?: true }
  | { type: "resolved"; id: string; runId?: string }
  | { type: "settled"; status: "completed" | "failed" | "stopped"; text: string; error?: string; stop?: boolean; runId?: string };
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
  readonly resident: boolean;
  readonly pid: number | undefined;
  readonly closed: Promise<Exit>;
  ready(): Promise<NativeSession>;
  /** Resolves only for an acknowledged native run; extension-handled input rejects without claiming task execution. */
  start(message: string, runId?: string): Promise<void>;
  send(message: string, mode: Delivery): Promise<void>;
  reply(answer: InteractionReply): Promise<void>;
  /** Resolve only after the captured turn cannot continue; uncertainty requires stop/release. */
  interrupt(): Promise<void>;
  /** Write this runtime's raw stream to another run's log file; the previous file keeps its bytes. */
  rotateLog(file: string): void;
  end(): Promise<{ exit: Exit; forced: boolean }>;
  stop(): Promise<{ exit: Exit; forced: boolean }>;
}

export function nativeSession(session: NativeSession | SessionHandle | undefined): NativeSession | undefined {
  if (!session) return undefined;
  return "cli" in session ? session : { cli: "pi", ...session };
}
