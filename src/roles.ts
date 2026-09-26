import path from "node:path";
import { readJson } from "./storage.js";
import type { Role, Thinking } from "./types.js";

export const defaultRoles: Record<string, Role> = {
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
      const allowed = ["description", "instructions", "provider", "model", "thinking"];
      if (Object.keys(role).some((key) => !allowed.includes(key))) throw new Error(`${file}: ${name} contains unknown fields`);
      if (typeof role.description !== "string" || typeof role.instructions !== "string" || !role.description.trim() || !role.instructions.trim()) throw new Error(`${file}: ${name} requires description and instructions`);
      for (const key of ["provider", "model", "thinking"]) {
        if (role[key] !== undefined && (typeof role[key] !== "string" || !(role[key] as string).trim())) throw new Error(`${file}: ${name}.${key} must be a non-empty string`);
      }
      if (role.thinking !== undefined && !levels.has(role.thinking as Thinking)) throw new Error(`${file}: invalid thinking level`);
      roles[name] = {
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
