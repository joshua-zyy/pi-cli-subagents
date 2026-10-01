import path from "node:path";
import { readJson } from "./storage.js";
import type { Effort, Role, Thinking } from "./types.js";

export const defaultRoles: Record<string, Role> = {
  explore: {
    description: "Investigate the code and report findings without changing project files",
    instructions: "Investigate the question assigned by the parent agent. Report the conclusion, the file and symbol locations that support it, the evidence you actually observed, and the questions you could not answer. Distinguish what you verified from what you inferred. Do not change project files, and do not implement the work you are investigating. Permissions follow the CLI configuration: these role instructions are not a read-only sandbox.",
  },
  worker: {
    description: "Implement a task and verify the changes",
    instructions: "Complete the implementation assigned by the parent agent. Change only authorized files. Verify the changes and report the result, actual edits and unresolved issues. Do not treat tool failures as success or delegate to further agents.",
  },
  reviewer: {
    description: "Review changes in an independent context",
    instructions: "Independently review the changes specified by the parent agent. Do not fix or modify the reviewed code. Report reproducible issues, file locations and evidence; distinguish finding no issues from being unable to review. Permissions follow the CLI configuration: these role instructions are not a read-only sandbox.",
  },
};
const levels = new Set<Thinking>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const efforts = new Set<Effort>(["none", "minimal", "low", "medium", "high", "xhigh"]);

export function loadRoles(agentDir: string, cwd: string, projectTrusted: boolean): Record<string, Role> {
  const roles = structuredClone(defaultRoles);
  const files = [path.join(agentDir, "cli-subagents.roles.json")];
  if (projectTrusted) files.push(path.join(cwd, ".pi", "cli-subagents.roles.json"));
  for (const file of files) {
    const value = readJson<unknown>(file);
    if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${file}: expected a JSON object mapping role names to configurations`);
    for (const [name, raw] of Object.entries(value)) {
      if (!/^[a-z][a-z0-9-]*$/.test(name) || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${file}: invalid role ${name}`);
      const role = raw as Record<string, unknown>;
      const allowed = ["description", "instructions", "provider", "model", "thinking", "cli", "effort"];
      if (Object.keys(role).some((key) => !allowed.includes(key))) throw new Error(`${file}: ${name} contains unknown fields`);
      if (typeof role.description !== "string" || typeof role.instructions !== "string" || !role.description.trim() || !role.instructions.trim()) throw new Error(`${file}: ${name} requires description and instructions`);
      for (const key of ["provider", "model", "thinking"]) {
        if (role[key] !== undefined && (typeof role[key] !== "string" || !(role[key] as string).trim())) throw new Error(`${file}: ${name}.${key} must be a non-empty string`);
      }
      if (role.thinking !== undefined && !levels.has(role.thinking as Thinking)) throw new Error(`${file}: invalid thinking level`);
      if (role.cli !== undefined && role.cli !== "pi" && role.cli !== "codex" && role.cli !== "claude") throw new Error(`${file}: ${name}.cli must be pi, codex or claude`);
      if (role.cli === "claude" && (role.provider || role.thinking)) throw new Error(`${file}: ${name} Claude role does not accept Pi provider/thinking fields`);
      if (role.effort !== undefined && !efforts.has(role.effort as Effort)) throw new Error(`${file}: invalid Codex effort`);
      if (role.cli === "codex" && (!role.model || role.provider || role.thinking)) throw new Error(`${file}: ${name} Codex role requires model and does not accept Pi provider/thinking fields`);
      if (role.cli !== "codex" && role.effort !== undefined) throw new Error(`${file}: ${name}.effort requires cli: codex`);
      roles[name] = {
        ...(role.cli ? { cli: role.cli as Role["cli"] } : {}),
        ...(role.effort ? { effort: role.effort as Effort } : {}),
        description: role.description as string,
        instructions: role.instructions as string,
        ...(role.provider ? { provider: role.provider as string } : {}),
        ...(role.model ? { model: role.model as string } : {}),
        ...(role.thinking ? { thinking: role.thinking as Thinking } : {}),
      };
    }
  }
  return roles;
}
