import { existsSync } from "node:fs";
import path from "node:path";
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
