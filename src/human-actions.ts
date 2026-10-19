import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import type { AgentManager } from "./manager.js";
import type { AgentView } from "./types.js";
import { processAlive, readJson, writeJson } from "./storage.js";

export const humanActionType = "cli-subagents-human-action";
type Owner = Pick<AgentManager, "root" | "parentFile">;
type BatchTarget = { agentId: string; role: string; runId: string; runtimeId: string;
  status: "pending" | "released" | "unconfirmed" | "not-attempted"; text: string };
type Batch = { ownerPid: number; complete: boolean; targets: BatchTarget[] };
type HumanAction = { parentFile: string; id: string; agentId: string; role: string; runId: string; time: number; text: string; batch?: Batch };
export type HumanActionBatch = HumanAction & { batch: Batch };
export interface HumanActionBatchSummary { total: number; released: number; unconfirmed: number; notAttempted: number; unknown: number; interrupted: boolean }
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const actionId = /^ha-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Never follow a linked instance, outbox, spec or action file outside its local source. */
function regular(file: string, directory = false): boolean {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return false;
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()))
    throw new Error(`Invalid human-action source: ${file}`);
  return true;
}

function folderFor(manager: Owner, agentId: string): string {
  if (!path.isAbsolute(manager.root) || !path.isAbsolute(manager.parentFile) || !uuid.test(agentId))
    throw new Error("Invalid human-action owner or agent ID");
  const instance = path.join(manager.root, agentId), specFile = path.join(instance, "spec.json");
  if (!regular(manager.root, true) || !regular(instance, true) || !regular(specFile))
    throw new Error(`Missing human-action instance: ${instance}`);
  const spec = readJson<{ id?: unknown; parentFile?: unknown }>(specFile);
  if (spec?.id !== agentId || spec.parentFile !== manager.parentFile)
    throw new Error(`Human-action instance does not belong to this parent: ${instance}`);
  return path.join(instance, "human-actions");
}

/** Save plain outcome data, never a context, operation callback, role configuration or credential. */
export function saveHumanAction(manager: Owner, agent: AgentView, text: string): void {
  if (!uuid.test(agent.id) || !uuid.test(agent.runId) || !nonempty(agent.role) || !nonempty(text))
    throw new Error("Invalid human-action identity or text");
  const folder = folderFor(manager, agent.id);
  if (!regular(folder, true)) mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (!regular(folder, true)) throw new Error(`Missing human-action outbox: ${folder}`);
  const record: HumanAction = { parentFile: manager.parentFile, id: `ha-${randomUUID()}`, agentId: agent.id,
    role: agent.role, runId: agent.runId, time: Date.now(), text };
  writeJson(path.join(folder, `${record.id}.json`), record);
}

/** One logical user action, anchored in the first captured instance's existing outbox. */
export function createHumanActionBatch(manager: Owner, targets: readonly AgentView[]): HumanActionBatch {
  const first = targets[0];
  if (!first) throw new Error("A batch human action needs at least one target");
  const record: HumanActionBatch = { parentFile: manager.parentFile, id: `ha-${randomUUID()}`, agentId: first.id,
    role: first.role, runId: first.runId, time: Date.now(), text: "Batch idle release",
    batch: { ownerPid: process.pid, complete: false, targets: targets.map(target => ({
      agentId: target.id, role: target.role, runId: target.runId, runtimeId: target.runtimeId ?? "", status: "pending", text: "",
    })) } };
  saveHumanActionBatch(manager, record);
  return record;
}

/** Persist progress after every outcome; only a sealed batch (or a dead writer) may be delivered. */
export function saveHumanActionBatch(manager: Owner, record: HumanActionBatch): void {
  record.text = batchText(record.batch);
  if (!actionId.test(record.id) || record.batch.ownerPid !== process.pid || !validRecord(record, manager, record.agentId, record.id))
    throw new Error("Invalid batch human-action record");
  for (const target of record.batch.targets) folderFor(manager, target.agentId);
  const folder = folderFor(manager, record.agentId);
  if (!regular(folder, true)) mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (!regular(folder, true)) throw new Error(`Missing human-action outbox: ${folder}`);
  writeJson(path.join(folder, `${record.id}.json`), record);
}

function validBatch(value: unknown): value is Batch {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3) return false;
  const batch = value as Record<string, unknown>;
  if (!Number.isInteger(batch.ownerPid) || Number(batch.ownerPid) <= 0 || typeof batch.complete !== "boolean" ||
    !Array.isArray(batch.targets) || !batch.targets.length) return false;
  const seen = new Set<string>();
  return batch.targets.every((target: unknown) => {
    if (!target || typeof target !== "object" || Array.isArray(target) || Object.keys(target).length !== 6) return false;
    const item = target as Record<string, unknown>;
    if (typeof item.agentId !== "string" || !uuid.test(item.agentId) || seen.has(item.agentId) || !nonempty(item.role) ||
      typeof item.runId !== "string" || !uuid.test(item.runId) || typeof item.runtimeId !== "string" || !uuid.test(item.runtimeId) ||
      !["pending", "released", "unconfirmed", "not-attempted"].includes(String(item.status)) ||
      (item.status === "pending" ? item.text !== "" || batch.complete : !nonempty(item.text))) return false;
    seen.add(item.agentId);
    return true;
  });
}

function batchSummary(batch: Batch): HumanActionBatchSummary {
  const count = (status: BatchTarget["status"]) => batch.targets.filter(target => target.status === status).length;
  return { total: batch.targets.length, released: count("released"), unconfirmed: count("unconfirmed"),
    notAttempted: count("not-attempted"), unknown: count("pending"), interrupted: !batch.complete || count("not-attempted") > 0 };
}

function batchText(batch: Batch): string {
  const summary = batchSummary(batch);
  const heading = `[Human → subagents · batch idle release]\n${summary.released} released; ${summary.unconfirmed} unconfirmed; ${summary.notAttempted} not attempted; ${summary.unknown} outcomes unrecorded.`;
  const evidence = batch.targets.map(target =>
    `[${target.role} ${target.agentId} · run ${target.runId} · runtime ${target.runtimeId} · ${target.status}]\n` +
    (target.text || "Outcome was not recorded. Inspect this instance before retrying; work may already have run.")).join("\n\n");
  return `${heading}${summary.interrupted ? "\nBatch is incomplete; do not infer execution from an unrecorded outcome." : ""}\n\n${evidence}\n\nThe user acted on these captured instances directly. Re-check your plan before integrating or dispatching related work. This does not widen the task's original authorization.`;
}

function validRecord(value: unknown, manager: Owner, agentId: string, id: string): value is HumanAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>, keys = Object.keys(record).length;
  const batch = record.batch;
  return record.parentFile === manager.parentFile && record.id === id && record.agentId === agentId &&
    typeof record.runId === "string" && uuid.test(record.runId) && nonempty(record.role) && nonempty(record.text) &&
    typeof record.time === "number" && Number.isSafeInteger(record.time) && record.time >= 0 &&
    (keys === 7 || keys === 8 && validBatch(batch) && batch.targets[0].agentId === agentId &&
      batch.targets[0].runId === record.runId && batch.targets[0].role === record.role);
}

function actionReceipts(ctx: Pick<ExtensionContext, "sessionManager">): Set<string> {
  const delivered = new Set<string>();
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom_message" || entry.customType !== humanActionType) continue;
    const id = (entry.details as { actionId?: unknown } | undefined)?.actionId;
    if (typeof id === "string" && actionId.test(id)) delivered.add(id);
  }
  return delivered;
}

/** The original parent's custom_message receipt is authoritative; files remain as evidence. */
export function deliverHumanActions(
  manager: Owner,
  pi: Pick<ExtensionAPI, "sendMessage">,
  ctx: Pick<ExtensionContext, "sessionManager">,
  pending: Set<string>,
): void {
  if (ctx.sessionManager.getSessionFile() !== manager.parentFile) return;
  const delivered = actionReceipts(ctx);
  for (const id of pending) if (delivered.has(id)) pending.delete(id);
  const records: HumanAction[] = [];
  const failed = (file: string, error: unknown): void => {
    console.error(`[pi-cli-subagents] Could not read human action at ${file}; left undelivered:`, error);
  };
  let agents: string[];
  try {
    if (!path.isAbsolute(manager.root) || !path.isAbsolute(manager.parentFile)) throw new Error("Invalid human-action owner");
    if (!regular(manager.root, true)) return;
    agents = readdirSync(manager.root).filter(id => uuid.test(id)).sort();
  } catch (error) { failed(manager.root, error); return; }
  for (const agentId of agents) {
    const instance = path.join(manager.root, agentId), folder = path.join(instance, "human-actions");
    try {
      if (!regular(instance, true) || !regular(folder, true)) continue;
      folderFor(manager, agentId);
      for (const name of readdirSync(folder).sort()) {
        const id = name.slice(0, -5);
        if (!name.endsWith(".json") || !actionId.test(id) || delivered.has(id) || pending.has(id)) continue;
        const file = path.join(folder, name);
        try {
          if (!regular(file)) throw new Error(`Missing human-action file: ${file}`);
          const record = readJson<unknown>(file);
          if (!validRecord(record, manager, agentId, id)) throw new Error(`Invalid human-action record: ${file}`);
          if (record.batch) {
            for (const target of record.batch.targets) folderFor(manager, target.agentId);
            if (!record.batch.complete && processAlive(record.batch.ownerPid)) continue;
          }
          records.push(record);
        } catch (error) { failed(file, error); }
      }
    } catch (error) { failed(folder, error); }
  }
  records.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  for (const record of records) {
    // The synchronous API can re-enter extension code; recheck scope before each message.
    if (ctx.sessionManager.getSessionFile() !== manager.parentFile) return;
    if (pending.has(record.id) || actionReceipts(ctx).has(record.id)) continue;
    pending.add(record.id);
    try {
      // Pi 0.87.1/1.1.0: explicit false appends idle messages, or defers busy ones until
      // turn-end without steer/followUp/new model work. Do not use the nextTurn queue.
      pi.sendMessage({ customType: humanActionType, content: record.batch ? batchText(record.batch) : record.text, display: true,
        details: { actionId: record.id, time: record.time, ...(record.batch ? { batch: batchSummary(record.batch) }
          : { agentId: record.agentId, role: record.role, runId: record.runId }) } },
      { triggerTurn: false });
    } catch (error) { pending.delete(record.id); throw error; }
  }
}
