import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Launch } from "./types.js";

/** Launch the native executable directly; never execute a Windows shell shim. */
export function claudeLaunch(): Launch {
  if (process.platform !== "win32") return { command: "claude", args: [] };
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const command = path.join(directory.replace(/^"|"$/g, ""), "claude.exe");
    if (existsSync(command)) return { command, args: [] };
  }
  throw new Error("Claude native CLI is not installed on PATH; Windows shell shims are not supported");
}

/**
 * Child environment for a Claude run. The user's own CLAUDE_CONFIG_DIR resolution is inherited
 * unchanged; the variable is pinned explicitly only when this session's recorded home differs,
 * because an explicit value relocates Claude Code's global state file into that directory.
 */
export function claudeEnvironment(home: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inherited = path.resolve(base.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
  return path.resolve(home) === inherited ? base : { ...base, CLAUDE_CONFIG_DIR: home };
}
