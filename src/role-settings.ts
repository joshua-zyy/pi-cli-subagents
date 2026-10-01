import path from "node:path";
import { EMPTY_CATALOG, modelEfforts, type ModelCatalog, type ModelEntry } from "./cli-discovery.js";
import { CLAUDE_MODES, CLAUDE_MODELS, CLAUDE_THINKING_LEVELS, CODEX_MODES, EFFORT_LEVELS, PI_THINKING_LEVELS, modeError, validateRoleFile } from "./roles.js";
import { readJson, writeJson } from "./storage.js";
import type { Cli, Effort, Mode, Role, Thinking } from "./types.js";

export type Scope = "user" | "project";
export type Origin = "built-in" | Scope;
export type EditableField = "cli" | "provider" | "model" | "thinking" | "effort" | "mode" | "description" | "instructions";

/** Text fields are edited in Pi's own dialogs; the rest are picked from a list. */
export const TEXT_FIELDS: EditableField[] = ["provider", "model", "description", "instructions"];
export const CHOICE_FIELDS: EditableField[] = ["cli", "thinking", "effort", "mode"];
export const FIELD_LABELS: Record<EditableField, string> = { cli: "cli", provider: "provider", model: "model", thinking: "thinking", effort: "effort", mode: "mode", description: "description", instructions: "instructions" };
/** Offered last in a discovered list, so a value the CLI did not publish stays reachable. */
export const CUSTOM_CHOICE = "✎ type a value…";

export interface ChoiceOptions {
  /** Which CLIs this machine can actually launch. */
  clis?: string[];
  /** Models and effort levels the local CLIs published, when the background probe has finished. */
  catalog?: ModelCatalog;
  /** True while that probe is still running, so a picker waits instead of falling back to text. */
  pending?: boolean;
}

export interface RoleRow {
  name: string;
  origin: Origin;
  /** Defaults merged with both role files; what `spawn_agent` actually runs. */
  effective: Role;
  /** Entry stored in the scope being edited, when the user already overrode this role there. */
  override: Role | undefined;
}

export function scopeFile(scope: Scope, agentDir: string, cwd: string): string {
  return scope === "user" ? path.join(agentDir, "cli-subagents.roles.json") : path.join(cwd, ".pi", "cli-subagents.roles.json");
}

/** Validated contents of one scope file; `{}` when it does not exist yet. */
export function readScope(scope: Scope, agentDir: string, cwd: string): Record<string, Role> {
  const file = scopeFile(scope, agentDir, cwd);
  const value = readJson<unknown>(file);
  if (value === undefined) return {};
  // Refuse to load a broken document into the editor instead of silently rewriting it.
  return validateRoleFile(value, file);
}

/** Validate the whole document before writing so a partial edit can never corrupt the file. */
export function writeScope(scope: Scope, agentDir: string, cwd: string, doc: Record<string, Role>): string {
  const file = scopeFile(scope, agentDir, cwd);
  writeJson(file, validateRoleFile(doc, file));
  return file;
}

export function roleRows(effective: Record<string, Role>, userDoc: Record<string, Role>, projectDoc: Record<string, Role>, scope: Scope): RoleRow[] {
  return Object.entries(effective).map(([name, role]) => ({
    name,
    origin: projectDoc[name] ? "project" : userDoc[name] ? "user" : "built-in",
    effective: role,
    override: (scope === "user" ? userDoc : projectDoc)[name],
  }));
}

/** Switching CLI drops the fields the target CLI rejects, mirroring `validateRoleFile`. */
export function withCli(role: Role, cli: Cli): Role {
  const next: Role = { cli, description: role.description, instructions: role.instructions };
  if (cli === "claude") {
    if (role.model) next.model = role.model;
    if (role.thinking && CLAUDE_THINKING_LEVELS.includes(role.thinking)) next.thinking = role.thinking;
  } else if (cli === "codex") {
    if (role.model) next.model = role.model;
    if (role.effort) next.effort = role.effort;
  } else {
    if (role.provider) next.provider = role.provider;
    if (role.model) next.model = role.model;
    if (role.thinking) next.thinking = role.thinking;
  }
  // The two CLIs name different postures, so a mode only survives its own CLI.
  if (role.mode && modeError(cli, role.mode) === undefined) next.mode = role.mode;
  return next;
}

const asCli = (value: string): Cli => (value === "codex" ? "codex" : value === "claude" ? "claude" : "pi");

export function setField(doc: Record<string, Role>, name: string, base: Role, field: EditableField, value: string): Record<string, Role> {
  const current = doc[name] ?? base;
  if (field === "cli") return { ...doc, [name]: withCli(current, asCli(value)) };
  if (field === "description") return { ...doc, [name]: { ...current, description: value } };
  if (field === "instructions") return { ...doc, [name]: { ...current, instructions: value } };
  const next: Role = { ...current };
  if (!value.trim()) {
    delete next[field as Exclude<EditableField, "cli" | "description" | "instructions">];
    return { ...doc, [name]: next };
  }
  if (field === "provider") next.provider = value;
  else if (field === "model") next.model = value;
  else if (field === "thinking") next.thinking = value as Thinking;
  else if (field === "mode") next.mode = value as Mode;
  else next.effort = value as Effort;
  return { ...doc, [name]: next };
}

export function deleteRole(doc: Record<string, Role>, name: string): Record<string, Role> {
  const next = { ...doc };
  delete next[name];
  return next;
}

/** Seed a new role with editable placeholders; `description`/`instructions` are required by validation. */
export function addRole(doc: Record<string, Role>, name: string): Record<string, Role> {
  if (doc[name]) return doc;
  return { ...doc, [name]: { description: `${name} role`, instructions: `Describe what the ${name} role must do, what it may change, and how it must report evidence.` } };
}

/** Catalog entries a role can actually use: Codex models, or Pi models filtered by its provider. */
export function catalogEntries(role: Role, field: EditableField, catalog: ModelCatalog): ModelEntry[] {
  if (role.cli === "codex") return field === "model" ? catalog.codex : [];
  if (role.cli !== "pi") return [];
  return field === "model" && role.provider ? catalog.pi.filter((entry) => entry.provider === role.provider) : catalog.pi;
}

/** Values a free-form field can offer, or nothing when it stays text. Claude publishes aliases, not a catalog. */
export function fieldValues(role: Role, field: EditableField, catalog: ModelCatalog): string[] {
  if (field === "provider") return [...new Set(catalogEntries(role, field, catalog).flatMap((entry) => entry.provider ?? []))];
  if (field === "model") return role.cli === "claude" ? [...CLAUDE_MODELS] : catalogEntries(role, field, catalog).map((entry) => entry.model);
  return [];
}

/** Whether this field can offer a list at all, right now or once discovery finishes. */
export function fieldIsChoice(role: Role, field: EditableField, options: ChoiceOptions = {}): boolean {
  if (CHOICE_FIELDS.includes(field)) return true;
  if (field !== "provider" && field !== "model") return false;
  if (fieldValues(role, field, options.catalog ?? EMPTY_CATALOG).length) return true;
  // Discovery is still running for the CLI that would publish this list: wait rather than ask for typing.
  if (!options.pending) return false;
  return field === "provider" ? (role.cli ?? "pi") === "pi" : role.cli !== undefined;
}

export function fieldChoices(role: Role, field: EditableField, options: ChoiceOptions = {}): string[] {
  const catalog = options.catalog ?? EMPTY_CATALOG;
  if (field === "cli") return [...(options.clis ?? ["pi", "codex", "claude"])];
  if (field === "thinking") return [...((role.cli ?? "pi") === "claude" ? CLAUDE_THINKING_LEVELS : PI_THINKING_LEVELS)];
  // A model that publishes its own levels replaces the generic list rather than adding to it.
  if (field === "effort") return [...(modelEfforts(catalog, role.model) ?? EFFORT_LEVELS)];
  if (field === "mode") return role.cli === "claude" ? [...CLAUDE_MODES] : role.cli === "codex" ? [...CODEX_MODES] : [];
  return field === "provider" || field === "model" ? fieldValues(role, field, catalog) : [];
}

export function fieldValue(role: Role, field: EditableField): string {
  const value = role[field];
  return typeof value === "string" ? value : "";
}

/** Fields the current CLI can actually use; CLI-specific options stay hidden until a CLI is chosen. */
export function visibleFields(role: Role): EditableField[] {
  // Pi is the default CLI, so a role that already carries Pi fields keeps them editable without
  // first forcing an explicit `"cli": "pi"` that would change nothing.
  if (!role.cli) return role.provider || role.model || role.thinking
    ? ["cli", "provider", "model", "thinking", "description", "instructions"]
    : ["cli", "description", "instructions"];
  if (role.cli === "codex") return ["cli", "model", "effort", "mode", "description", "instructions"];
  if (role.cli === "claude") return ["cli", "model", "thinking", "mode", "description", "instructions"];
  return ["cli", "provider", "model", "thinking", "description", "instructions"];
}

/** One-line reminder of what each CLI makes configurable, shown while picking a CLI. */
export function cliDetail(cli: string): string {
  if (cli === "codex") return "model (required) · effort (reasoning) · mode (approvals + sandbox)";
  if (cli === "claude") return "model (optional) · thinking (native --effort) · mode (native permission mode)";
  return "provider · model · thinking";
}

/** What the native CLI does with each posture, so a mode is chosen deliberately rather than guessed. */
export function modeDetail(mode: string): string {
  if (mode === "manual") return "reads only; edits, shell and network ask";
  if (mode === "acceptEdits") return "in-scope edits auto-approved; other tools ask";
  if (mode === "plan") return "reads auto-approved; writes always ask";
  if (mode === "auto") return "a classifier approves most calls; some still ask";
  if (mode === "dontAsk") return "no prompts: anything unapproved is denied";
  if (mode === "bypassPermissions") return "nearly everything auto-approved, except the never-auto-approved set";
  if (mode === "read-only") return "sandbox read-only; the model asks before escaping";
  if (mode === "workspace-write") return "sandbox workspace-write; the model asks before escaping";
  if (mode === "full-access") return "no approvals and no sandbox";
  return "";
}

/** Postures that remove the native approval request, so the parent's approval surface goes silent. */
export function suppressesApprovals(mode: string): boolean {
  return mode === "dontAsk" || mode === "bypassPermissions" || mode === "full-access";
}

export function roleSummary(role: Role): string {
  const cli = role.cli ?? "pi";
  const mode = role.mode ? ` · mode ${role.mode}` : "";
  if (cli === "codex") return `codex · ${role.model ?? "model required"} · effort ${role.effort ?? "default"}${mode}`;
  if (cli === "claude") return `claude · ${role.model ?? "native model"} · ${role.thinking ? `effort ${role.thinking}` : "native effort"}${mode}`;
  return `pi · ${role.provider ?? "default provider"}/${role.model ?? "default model"} · thinking ${role.thinking ?? "off"}`;
}
