import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { claudeLaunch } from "./claude-launch.js";
import { codexLaunch } from "./codex-launch.js";
import type { Cli, Launch } from "./types.js";

/** One selectable model, taken from the CLI's own catalog instead of a list this plugin maintains. */
export interface ModelEntry { provider?: string; model: string; efforts?: string[] }
export interface ModelCatalog { pi: ModelEntry[]; codex: ModelEntry[] }
export const EMPTY_CATALOG: ModelCatalog = { pi: [], codex: [] };

/** `pi --list-models` prints one aligned row per model under a header that names the columns. */
export function parsePiModels(text: string): ModelEntry[] {
  const entries: ModelEntry[] = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const [provider, model] = line.trim().split(/\s{2,}/);
    if (provider && model) entries.push({ provider, model });
  }
  return entries;
}

/** `codex debug models` prints its catalog as JSON, including each model's own effort levels. */
export function parseCodexModels(text: string): ModelEntry[] {
  const models = (JSON.parse(text) as { models?: unknown }).models;
  if (!Array.isArray(models)) throw new Error("codex debug models did not return a model list");
  return models.flatMap((raw) => {
    const model = (raw as { slug?: unknown }).slug;
    if (typeof model !== "string" || !model) return [];
    const levels = (raw as { supported_reasoning_levels?: unknown }).supported_reasoning_levels;
    const efforts = Array.isArray(levels)
      ? levels.flatMap((level) => { const effort = (level as { effort?: unknown }).effort; return typeof effort === "string" ? [effort] : []; })
      : [];
    return [{ model, ...(efforts.length ? { efforts } : {}) }];
  });
}

/** Whether a command resolves on PATH. The Windows launchers already check; the POSIX ones assume. */
export function onPath(command: string): boolean {
  return (process.env.PATH ?? "").split(path.delimiter).some((directory) => {
    if (!directory) return false;
    const clean = directory.replace(/^"|"$/g, "");
    return existsSync(path.join(clean, command)) || (process.platform === "win32" && existsSync(path.join(clean, `${command}.exe`)));
  });
}

function launchable(resolve: () => Launch): boolean {
  try { const launch = resolve(); return process.platform === "win32" || onPath(launch.command); }
  catch { return false; }
}

/** Pi is the host process; Codex and Claude Code are optional, and a CLI that is not installed is not offered. */
export function detectClis(): Record<Cli, boolean> {
  return { pi: true, codex: launchable(codexLaunch), claude: launchable(claudeLaunch) };
}

function run(launch: Launch, args: string[], cwd: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(launch.command, [...launch.args, ...args], { cwd, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => error ? reject(error) : resolve(stdout));
    // Close stdin: a CLI that reads it would otherwise wait for the whole timeout instead of answering.
    child.stdin?.end();
  });
}

/**
 * Ask each installed CLI for its own catalog. A CLI that is missing, unauthenticated, too slow or
 * answers in an unexpected shape simply contributes nothing, and that field stays free text.
 */
export async function probeCatalog(options: { pi: Launch; cwd: string; available?: Record<Cli, boolean>; timeout?: number }): Promise<ModelCatalog> {
  const timeout = options.timeout ?? 20_000, available = options.available ?? detectClis();
  const [pi, codex] = await Promise.all([
    available.pi ? run(options.pi, ["--list-models"], options.cwd, timeout).then(parsePiModels).catch(() => []) : Promise.resolve([]),
    available.codex ? run(codexLaunch(), ["debug", "models"], options.cwd, timeout).then(parseCodexModels).catch(() => []) : Promise.resolve([]),
  ]);
  return { pi, codex };
}

/** The effort levels the chosen model actually publishes, when its catalog entry is known. */
export function modelEfforts(catalog: ModelCatalog, model: string | undefined): string[] | undefined {
  return catalog.codex.find((entry) => entry.model === model)?.efforts;
}
