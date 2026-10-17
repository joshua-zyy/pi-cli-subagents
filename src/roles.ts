import path from "node:path";
import { readJson } from "./storage.js";
import type { ClaudeMode, Cli, CodexMode, Effort, Mode, Role, RoleToolTrim, Thinking } from "./types.js";

/** Built-ins run on Pi; a role that needs Codex or Claude Code opts in with an explicit `cli`. */
export const defaultRoles: Record<string, Role> = {
  explore: {
    cli: "pi",
    description: "Investigate the code and report findings without changing project files",
    instructions: "Investigate the question assigned by the parent agent. Report the conclusion, the file and symbol locations that support it, the evidence you actually observed, and the questions you could not answer. Distinguish what you verified from what you inferred. Do not change project files, and do not implement the work you are investigating. Permissions follow the CLI configuration: these role instructions are not a read-only sandbox.",
  },
  worker: {
    cli: "pi",
    description: "Implement a task and verify the changes",
    instructions: "Complete the implementation assigned by the parent agent. Change only authorized files. Verify the changes and report the result, actual edits and unresolved issues. Do not treat tool failures as success or delegate to further agents.",
  },
  reviewer: {
    cli: "pi",
    description: "Review changes in an independent context",
    instructions: "Independently review the changes specified by the parent agent. Do not fix or modify the reviewed code. Report reproducible issues, file locations and evidence; distinguish finding no issues from being unable to review. Permissions follow the CLI configuration: these role instructions are not a read-only sandbox.",
  },
  oracle: {
    cli: "pi",
    description: "Answer a question or give a judgment from the material it is handed",
    instructions: "Answer the question or give the judgment the parent agent asked for. Reason from the material you are given and read more only when it would change the answer; do not investigate the codebase as an end in itself. Do not change project files and do not implement the work. Lead with your conclusion, then the reasoning, the assumptions you had to make, what you did not verify, and how confident you are. Say plainly when the question cannot be answered as asked, and do not delegate to further agents.",
  },
};

/** Choices shared by role validation and the `/cli-agents-setting` editor. */
export const CLI_CHOICES: Cli[] = ["pi", "codex", "claude"];
export const PI_THINKING_LEVELS: Thinking[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** Claude Code accepts exactly these `--effort` levels; `off`/`minimal` have no native equivalent. */
export const CLAUDE_THINKING_LEVELS: Thinking[] = ["low", "medium", "high", "xhigh", "max"];
/** The levels Codex commonly publishes; a model's own catalog replaces this list in the editor. */
export const EFFORT_LEVELS: Effort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
/** Claude modes are passed straight through as `--permission-mode`; the CLI owns the meaning. */
export const CLAUDE_MODES: ClaudeMode[] = ["acceptEdits", "auto", "manual", "dontAsk", "plan", "bypassPermissions"];
/** The `--model` aliases the native CLI documents; a full model name is still typed in the panel. */
export const CLAUDE_MODELS: string[] = ["opus", "sonnet", "haiku", "fable"];
/**
 * Codex exposes approval policy and sandbox as separate axes. A role picks one named preset so a
 * single mistake cannot produce an unintended combination such as `never` with a writable sandbox.
 */
export const CODEX_MODE_PRESETS: Record<CodexMode, { approvalPolicy: "untrusted" | "on-request" | "never"; sandbox: "read-only" | "workspace-write" | "danger-full-access" }> = {
  "read-only": { approvalPolicy: "on-request", sandbox: "read-only" },
  "workspace-write": { approvalPolicy: "on-request", sandbox: "workspace-write" },
  "full-access": { approvalPolicy: "never", sandbox: "danger-full-access" },
};
export const CODEX_MODES = Object.keys(CODEX_MODE_PRESETS) as CodexMode[];
export const ROLE_FIELDS = ["description", "instructions", "provider", "model", "thinking", "cli", "effort", "mode", "defaultModeQuestions", "tools", "skills", "mcp", "allowSubagents"] as const;

const levels = new Set<Thinking>(PI_THINKING_LEVELS);
const claudeLevels = new Set<Thinking>(CLAUDE_THINKING_LEVELS);

/**
 * Why `tools` cannot be used for this CLI, or `undefined` when it is valid. Shared with
 * `AgentManager.spawn`: the field is Pi-only, so any other backend must refuse it instead of silently
 * keeping every tool.
 */
export function toolTrimError(cli: Cli | undefined, tools: unknown): string | undefined {
  // Claude 2.1.296 does expose --allowedTools/--disallowedTools, but this extension does not wire them yet;
  // saying "no list exists" would be false, and accepting the field would silently keep every tool.
  if (cli === "codex") return "tools requires a Pi role: Codex exposes no tool allow/deny list, so the role would silently keep every tool";
  if (cli === "claude") return "tools is not wired for Claude yet (its --allowedTools/--disallowedTools are unverified here), so the role would silently keep every tool";
  if (!tools || typeof tools !== "object" || Array.isArray(tools)) return "tools must be an object with allow and/or deny";
  const unknown = Object.keys(tools).filter((key) => key !== "allow" && key !== "deny");
  if (unknown.length) return `tools contains unknown fields: ${unknown.join(", ")}`;
  const record = tools as Record<string, unknown>;
  for (const key of ["allow", "deny"] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || !value.length) return `tools.${key} must be a non-empty array of tool names`;
    if (value.some((name) => typeof name !== "string" || !name.trim() || name !== name.trim()))
      return `tools.${key} must contain non-empty tool names without surrounding spaces`;
  }
  if (!record.allow && !record.deny) return "tools needs allow and/or deny";
  return undefined;
}

/**
 * Why `skills` cannot be used for this CLI, or `undefined` when it is valid. Pi only: the other backends
 * expose no switch, so accepting the field would silently keep every skill.
 */
export function mcpError(cli: Cli | undefined, mcp: unknown): string | undefined {
  if (cli !== undefined && cli !== "pi") return "mcp requires a Pi role: Codex and Claude expose no MCP switch, so the role would silently keep every server";
  if (typeof mcp !== "boolean") return "mcp must be true or false";
  return undefined;
}

/** Why `skills` cannot be used for this CLI, or `undefined` when it is valid. */
export function skillsError(cli: Cli | undefined, skills: unknown): string | undefined {
  if (cli !== undefined && cli !== "pi") return "skills requires a Pi role: Codex and Claude expose no skill switch, so the role would silently keep every skill";
  if (typeof skills === "boolean") return undefined;
  if (!Array.isArray(skills) || !skills.length) return "skills must be true, false or a non-empty array of skill paths";
  if (skills.some((path) => typeof path !== "string" || !path.trim() || path !== path.trim()))
    return "skills paths must be non-empty strings without surrounding spaces";
  return undefined;
}
/** Why `mode` cannot be used for this CLI, or `undefined` when it is valid. Shared with `AgentManager.spawn`. */
export function modeError(cli: Cli | undefined, mode: string): string | undefined {
  if (cli === "claude") return CLAUDE_MODES.includes(mode as ClaudeMode) ? undefined : `Claude mode must be one of ${CLAUDE_MODES.join(", ")}`;
  if (cli === "codex") return CODEX_MODES.includes(mode as CodexMode) ? undefined : `Codex mode must be one of ${CODEX_MODES.join(", ")}`;
  return "mode requires cli: claude or codex";
}

/**
 * Validate one roles document and return only its allowed fields.
 * `source` names the file in every error so both loaders and the settings editor can reuse it.
 */
export function validateRoleFile(value: unknown, source: string): Record<string, Role> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${source}: expected a JSON object mapping role names to configurations`);
  const roles: Record<string, Role> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${source}: invalid role ${name}`);
    const role = raw as Record<string, unknown>;
    if (Object.keys(role).some((key) => !ROLE_FIELDS.includes(key as typeof ROLE_FIELDS[number]))) throw new Error(`${source}: ${name} contains unknown fields`);
    if (typeof role.description !== "string" || typeof role.instructions !== "string" || !role.description.trim() || !role.instructions.trim()) throw new Error(`${source}: ${name} requires description and instructions`);
    for (const key of ["provider", "model", "thinking", "effort"]) {
      if (role[key] !== undefined && (typeof role[key] !== "string" || !(role[key] as string).trim())) throw new Error(`${source}: ${name}.${key} must be a non-empty string`);
    }
    if (role.mode !== undefined && (typeof role.mode !== "string" || !role.mode.trim())) throw new Error(`${source}: ${name}.mode must be a non-empty string`);
    if (role.thinking !== undefined && !levels.has(role.thinking as Thinking)) throw new Error(`${source}: invalid thinking level`);
    if (role.cli !== undefined && !CLI_CHOICES.includes(role.cli as Cli)) throw new Error(`${source}: ${name}.cli must be pi, codex or claude`);
    if (role.defaultModeQuestions !== undefined && (role.cli !== "codex" || typeof role.defaultModeQuestions !== "boolean")) throw new Error(`${source}: ${name}.defaultModeQuestions requires cli: codex and a boolean`);
    if (role.tools !== undefined) {
      const invalid = toolTrimError(role.cli as Cli | undefined, role.tools);
      if (invalid) throw new Error(`${source}: ${name} ${invalid}`);
    }
    if (role.skills !== undefined) {
      const invalid = skillsError(role.cli as Cli | undefined, role.skills);
      if (invalid) throw new Error(`${source}: ${name} ${invalid}`);
    }
    if (role.mcp !== undefined) {
      const invalid = mcpError(role.cli as Cli | undefined, role.mcp);
      if (invalid) throw new Error(`${source}: ${name} ${invalid}`);
    }
    if (role.allowSubagents !== undefined && typeof role.allowSubagents !== "boolean") throw new Error(`${source}: ${name}.allowSubagents must be a boolean`);
    if (role.cli === "claude" && role.provider) throw new Error(`${source}: ${name} Claude role does not accept a Pi provider`);
    if (role.cli === "claude" && role.thinking !== undefined && !claudeLevels.has(role.thinking as Thinking)) throw new Error(`${source}: ${name} Claude thinking must be low, medium, high, xhigh or max`);
    if (role.cli === "codex" && (role.provider || role.thinking)) throw new Error(`${source}: ${name} Codex role does not accept Pi provider/thinking fields`);
    if (role.cli !== "codex" && role.effort !== undefined) throw new Error(`${source}: ${name}.effort requires cli: codex`);
    if (role.mode !== undefined) {
      const invalid = modeError(role.cli as Cli | undefined, role.mode);
      if (invalid) throw new Error(`${source}: ${name} ${invalid}`);
    }
    roles[name] = {
      ...(role.cli ? { cli: role.cli as Cli } : {}),
      ...(role.effort ? { effort: role.effort as Effort } : {}),
      description: role.description as string,
      instructions: role.instructions as string,
      ...(role.provider ? { provider: role.provider as string } : {}),
      ...(role.model ? { model: role.model as string } : {}),
      ...(role.thinking ? { thinking: role.thinking as Thinking } : {}),
      ...(role.mode ? { mode: role.mode as Mode } : {}),
      ...(role.defaultModeQuestions !== undefined ? { defaultModeQuestions: role.defaultModeQuestions as boolean } : {}),
      ...(role.tools !== undefined ? { tools: role.tools as RoleToolTrim } : {}),
      ...(role.skills !== undefined ? { skills: role.skills as boolean | string[] } : {}),
      ...(role.mcp !== undefined ? { mcp: role.mcp as boolean } : {}),
      ...(role.allowSubagents !== undefined ? { allowSubagents: role.allowSubagents as boolean } : {}),
    };
  }
  return roles;
}

export function loadRoles(agentDir: string, cwd: string, projectTrusted: boolean): Record<string, Role> {
  const files = [path.join(agentDir, "cli-subagents.roles.json")];
  if (projectTrusted) files.push(path.join(cwd, ".pi", "cli-subagents.roles.json"));
  const documents = files.map((file) => {
    const value = readJson<unknown>(file);
    return value === undefined ? {} : validateRoleFile(value, file);
  });
  return mergeRoles(documents);
}

/** Later documents replace earlier ones field-by-field at role granularity, over the built-ins. */
export function mergeRoles(documents: Array<Record<string, Role>>): Record<string, Role> {
  const roles = structuredClone(defaultRoles);
  for (const document of documents) Object.assign(roles, document);
  return roles;
}
