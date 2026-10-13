import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexLaunch } from "./codex-launch.js";
import { killProcessTree } from "./process-tree.js";
import { readJson } from "./storage.js";
import { CODEX_MODE_PRESETS, CLAUDE_MODES, CLAUDE_THINKING_LEVELS } from "./roles.js";
import type { Cli, Role } from "./types.js";

/** Display only: none of these values are role overrides or launch arguments. */
export type DefaultValues = Partial<Record<"provider" | "model" | "thinking" | "effort" | "mode" | "defaultModeQuestions", string>>;
type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
const levels: readonly string[] = CLAUDE_THINKING_LEVELS;

export function codexDefaultValues(config: Json): DefaultValues {
  const sandbox = text(config.sandbox_mode), approval = text(config.approval_policy);
  const preset = Object.entries(CODEX_MODE_PRESETS).find(([, value]) => value.sandbox === sandbox && value.approvalPolicy === approval)?.[0];
  return { model: text(config.model) ?? "default", effort: text(config.model_reasoning_effort) ?? "default",
    mode: preset ?? (sandbox && approval ? `${sandbox} / ${approval}` : "default"),
    defaultModeQuestions: object(config.features) && typeof config.features.default_mode_request_user_input === "boolean" ? String(config.features.default_mode_request_user_input) : "default" };
}

/** No thread/start, turn/start or writes: use Codex's own layering/profile resolver. */
export function readCodexDefaults(cwd: string, timeout = 5000): Promise<DefaultValues | undefined> {
  return new Promise<DefaultValues | undefined>((resolve) => {
    const launch = codexLaunch();
    const child = spawn(launch.command, [...launch.args, "app-server"], { cwd, stdio: ["pipe", "pipe", "ignore"], shell: false, windowsHide: true, detached: process.platform !== "win32" });
    let buffer = "", bytes = 0, result: DefaultValues | undefined, failed = false;
    const stop = () => {
      if (failed) return;
      failed = true; clearTimeout(timer);
      void killProcessTree(child).then(() => resolve(undefined));
    };
    const timer = setTimeout(stop, timeout);
    child.on("error", stop);
    child.stdin.on("error", stop);
    child.stdout.on("error", stop);
    child.on("close", (code) => { clearTimeout(timer); resolve(!failed && code === 0 ? result : undefined); });
    const send = (message: Json) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (failed) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 4 * 1024 * 1024) { stop(); return; }
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const response: unknown = JSON.parse(line);
          if (!object(response)) { stop(); return; }
          if (response.error) { stop(); return; }
          if (response.id === 1) {
            send({ method: "initialized", params: {} });
            send({ id: 2, method: "config/read", params: { cwd, includeLayers: false } });
          } else if (response.id === 2) {
            const config = object(response.result) ? response.result.config : undefined;
            if (!object(config)) { stop(); return; }
            result = codexDefaultValues(config);
            child.stdin.end();
          }
        } catch { stop(); return; }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "pi_cli_subagents_settings", title: "Role settings", version: "0.1.0" } } });
  }).catch(() => undefined);
}

interface ClaudeSource { user: boolean; model?: string; effort?: string; cap?: string; mode?: string; models: Record<string, { effort?: string; cap?: string }>; env: Record<string, string> }
export interface ClaudeDefaults { sources: ClaudeSource[]; env: Record<string, string> }

/** Read only local settings. Never execute hooks/helpers or fetch account/server policy. */
export function readClaudeDefaults(cwd: string, env: NodeJS.ProcessEnv = process.env): ClaudeDefaults | undefined {
  try {
    const home = path.resolve(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
    const managed = process.platform === "win32" ? path.join(env.ProgramFiles || "C:\\Program Files", "ClaudeCode", "managed-settings.json")
      : process.platform === "darwin" ? "/Library/Application Support/ClaudeCode/managed-settings.json" : "/etc/claude-code/managed-settings.json";
    // A non-Windows local file can live at the Git root/main checkout. Do not guess that path.
    if (process.platform !== "win32" && (!statSync(path.join(cwd, ".git")).isDirectory() || path.resolve(cwd) === path.resolve(os.homedir()))) return undefined;
    const files = [path.join(home, "settings.json"), path.join(cwd, ".claude", "settings.json"), path.join(cwd, ".claude", "settings.local.json"), managed];
    const sources: ClaudeSource[] = [];
    for (const [index, file] of files.entries()) {
      const raw = readJson<Json>(file);
      if (raw === undefined) continue;
      if (!object(raw) || raw.policyHelper) return undefined;
      const vars: Record<string, string> = {};
      for (const [key, value] of Object.entries(object(raw.env) ? raw.env : {}))
        if (/^(ANTHROPIC_(MODEL|DEFAULT_MODEL|DEFAULT_(OPUS|SONNET|HAIKU|FABLE)_MODEL)|CLAUDE_CODE_EFFORT_LEVEL)$/.test(key) && text(value)) vars[key] = value as string;
      const models: ClaudeSource["models"] = Object.create(null);
      for (const [key, entry] of Object.entries(object(raw.modelSettings) ? raw.modelSettings : {})) {
        if (object(entry)) models[key] = { effort: text(entry.effortLevel), cap: text(entry.maxEffortLevel) };
      }
      let mode = text(object(raw.permissions) ? raw.permissions.defaultMode : undefined);
      if (mode === "default") mode = "manual";
      if ((index === 1 || index === 2) && mode === "auto") mode = "default";
      if ((index === 1 || index === 2) && mode === "bypassPermissions") mode = "manual";
      sources.push({ user: index === 0, model: text(raw.model), effort: text(raw.effortLevel), cap: text(raw.maxEffortLevel), mode, models, env: vars });
    }
    const variables: Record<string, string> = {};
    for (const key of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_MODEL", "CLAUDE_CODE_EFFORT_LEVEL", ...["OPUS", "SONNET", "HAIKU", "FABLE"].map(name => `ANTHROPIC_DEFAULT_${name}_MODEL`)])
      if (text(env[key])) variables[key] = env[key]!;
    for (const source of sources) Object.assign(variables, source.env);
    return { sources, env: variables };
  } catch { return undefined; }
}

export function claudeDefaultValues(settings: ClaudeDefaults, role: Role): DefaultValues {
  const { sources, env } = settings, highest = [...sources].reverse();
  const model = env.ANTHROPIC_MODEL ?? highest.find(source => source.model)?.model ?? env.ANTHROPIC_DEFAULT_MODEL ?? "default";
  const chosen = role.model ?? model;
  const resolved = env[`ANTHROPIC_DEFAULT_${chosen.toUpperCase()}_MODEL`] ?? chosen;
  const canonical = resolved.replace(/\[1m\]$/, "").replace(/-\d{8}$/, "");
  let effort: string | undefined, cap = levels.length - 1;
  for (const source of sources) {
    const entry = Object.hasOwn(source.models, canonical) ? source.models[canonical] : undefined;
    // The legacy user effort key does not apply to Opus 5.5+; unknown aliases may resolve to it.
    const legacy = !source.user || /^claude-(opus-(4|5(?:$|-0))|sonnet-4|haiku-4|fable-5-1)/.test(canonical);
    effort = entry?.effort ?? (legacy ? source.effort : undefined) ?? effort;
    const limit = entry?.cap ?? source.cap, level = limit ? levels.indexOf(limit) : -1;
    if (level >= 0) cap = Math.min(cap, level);
  }
  effort = env.CLAUDE_CODE_EFFORT_LEVEL ?? effort;
  const level = effort ? levels.indexOf(effort) : -1;
  if (level >= 0 && level > cap) effort = levels[cap];
  const mode = highest.find(source => source.mode)?.mode;
  return { model, thinking: effort && (levels.includes(effort) || effort === "auto") ? effort : "default",
    mode: mode && ((CLAUDE_MODES as readonly string[]).includes(mode) || mode === "default") ? mode : "default" };
}

export interface NativeDefaults { codex?: DefaultValues; claude?: ClaudeDefaults }
export async function probeRoleDefaults(cwd: string, available: Record<Cli, boolean>): Promise<NativeDefaults> {
  const claude = available.claude ? readClaudeDefaults(cwd) : undefined;
  const codex = available.codex ? await readCodexDefaults(cwd) : undefined;
  return { codex, claude };
}
