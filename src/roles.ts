import path from "node:path";
import { readJson } from "./storage.js";
import type { Role, Thinking } from "./types.js";

export const defaultRoles: Record<string, Role> = {
  worker: {
    description: "实施任务并验证改动",
    instructions: "完成主 agent 指定的实施任务，仅修改授权范围内的文件。验证改动并报告结果、实际修改和未解决的问题。不要把工具失败当作成功，不要自行派发其他代理。",
  },
  reviewer: {
    description: "在独立上下文中审查指定改动",
    instructions: "独立审查主 agent 指定的改动，不自行修复或修改被审查代码。报告可复现的问题、文件位置及依据；区分未发现问题和无法完成审查。权限沿用原 CLI 配置，这段职责说明不是只读沙箱。",
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
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${file}: 需要角色名称到配置的 JSON 对象`);
    for (const [name, raw] of Object.entries(value)) {
      if (!/^[a-z][a-z0-9-]*$/.test(name) || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${file}: 无效角色 ${name}`);
      const role = raw as Record<string, unknown>;
      const allowed = ["description", "instructions", "provider", "model", "thinking"];
      if (Object.keys(role).some((key) => !allowed.includes(key))) throw new Error(`${file}: ${name} 包含未知字段`);
      if (typeof role.description !== "string" || typeof role.instructions !== "string" || !role.description.trim() || !role.instructions.trim()) throw new Error(`${file}: ${name} 需要 description 和 instructions`);
      for (const key of ["provider", "model", "thinking"]) {
        if (role[key] !== undefined && (typeof role[key] !== "string" || !(role[key] as string).trim())) throw new Error(`${file}: ${name}.${key} 必须是非空字符串`);
      }
      if (role.thinking !== undefined && !levels.has(role.thinking as Thinking)) throw new Error(`${file}: 无效 thinking`);
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
