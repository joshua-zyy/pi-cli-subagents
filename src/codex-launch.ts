import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Launch } from "./types.js";

/** Preserve PATH order: native exe first per directory, otherwise bypass npm shell shims via Node. */
export function codexLaunch(): Launch {
  if (process.platform !== "win32") return { command: "codex", args: [] };
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const clean = directory.replace(/^"|"$/g, "");
    const native = path.join(clean, "codex.exe");
    if (existsSync(native)) return { command: native, args: [] };
    const entry = path.join(clean, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(entry)) return { command: process.execPath, args: [entry] };
  }
  throw new Error("Codex CLI is not installed on PATH; no Windows shell shim can be launched with shell:false");
}

export function codexHome(): string {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}
