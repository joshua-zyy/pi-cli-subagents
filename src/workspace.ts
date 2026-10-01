import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { directories, readJson, writeJson } from "./storage.js";
import type { AgentSpec, AgentState } from "./types.js";

export interface Integration {
  revision?: number;
  status: "applying" | "applied" | "uncertain";
  tree: string;
  time: number;
  patchFile: string;
  /** Binary patch from the workspace baseline; absent on legacy records. */
  checkpointFile?: string;
  backupFile: string;
  changedFiles: string[];
}
export interface SnapshotOptions {
  /** The caller must confirm that all inherited parent changes are authorized. */
  includeUncommitted?: { reason: string };
}
export type BaselineMode = "keep" | "sync";
export interface ResumeOptions extends SnapshotOptions {
  baseline?: BaselineMode;
  /** Bind a human dialog to what was actually shown; not a model-facing option. */
  expectedRevision?: number;
  expectedParentTree?: string;
}
export interface WorkspaceSync {
  revision?: number;
  status: "applying" | "applied" | "uncertain";
  previousBase: string;
  nextBase: string;
  parentCommit: string;
  tree: string;
  time: number;
  patchFile: string;
  backupFile: string;
  indexBackupFile: string;
  changedFiles: string[];
  reason?: string;
  previousIntegration?: Integration;
}
/** Only these explicit decisions may open a UI confirmation; other errors must not be retried. */
export class WorkspaceDecisionRequired extends Error {
  constructor(readonly decision: "baseline" | "inherit", readonly workspace: Workspace,
    message: string, readonly parentChanges: string[] = [], readonly parentTree?: string) { super(message); }
}
export interface Workspace {
  version: 1;
  revision: number;
  id: string;
  parentFile: string;
  repo: string;
  commonDir: string;
  path: string;
  cwd: string;
  baseCommit: string;
  parentCommit?: string;
  snapshotReason?: string;
  createdAt: number;
  status: "creating" | "ready" | "failed";
  parentChanges: string[];
  error?: string;
  integration?: Integration;
  /** Explicit continuation was authorized for the current integration checkpoint. */
  continuation?: boolean;
  sync?: WorkspaceSync;
}
export interface WorkspaceView extends Workspace {
  changedFiles: string[];
  occupiedBy: string[];
}
export interface IntegrationResult {
  workspace: string;
  status: "applied" | "already_integrated" | "no_changes";
  patchFile?: string;
  changedFiles: string[];
}

const idPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const parentOperations = new Map<string, Promise<unknown>>();
const split = (data: Buffer): string[] => data.toString("utf8").split("\0").filter(Boolean);
const inside = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
};

/** Git never inherits an alternate index/worktree from the launching shell. No shell or hooks. */
function git(cwd: string, args: string[], input?: Buffer, extraEnv?: NodeJS.ProcessEnv): Promise<Buffer> {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["-c", "core.hooksPath=", "-c", "core.fsmonitor=false", "-C", cwd, ...args], {
      env: { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", ...extraEnv },
      encoding: "buffer", windowsHide: true, timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args[0]} failed: ${stderr.toString("utf8").trim() || error.message}`));
      else resolve(stdout);
    });
    child.stdin?.on("error", () => { /* execFile reports a rejected/closed Git command */ });
    child.stdin?.end(input);
  });
}

/** A crash leaves the lock for inspection. Never guess that a previous owner is safe to replace. */
async function locked<T>(file: string, operation: string, action: () => Promise<T>): Promise<T> {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let fd: number;
  try { fd = openSync(file, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Workspace operation is busy or a stale lock remains: ${file}. Wait for its owner, or inspect it before retrying.`);
    throw error;
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, operation, time: Date.now() }));
    return await action();
  } finally { closeSync(fd); unlinkSync(file); }
}

/** Owns Git operations and workspace leases; agent execution stays in AgentManager. */
export class WorkspaceStore {
  readonly root: string;
  readonly parentFile: string;
  constructor(parentFile: string) {
    this.parentFile = path.resolve(parentFile);
    this.root = `${this.parentFile}.subagents`;
  }
  private directory(id: string): string {
    if (!idPattern.test(id)) throw new Error("Invalid workspace id");
    return path.join(this.root, "workspaces", id);
  }
  private save(ws: Workspace): void { writeJson(path.join(this.directory(ws.id), "workspace.json"), ws); }
  get(id: string): Workspace {
    const ws = readJson<Workspace>(path.join(this.directory(id), "workspace.json"));
    if (!ws || ws.version !== 1 || ws.id !== id || ws.parentFile !== this.parentFile) throw new Error("Workspace is missing or does not belong to this parent session");
    return { ...ws, revision: ws.revision ?? (ws.integration ? 1 : 0) };
  }
  private records(): Workspace[] {
    return directories(path.join(this.root, "workspaces")).filter(id => idPattern.test(id)).map(id => this.get(id));
  }
  private occupied(id: string): string[] {
    return directories(this.root).filter(agentId => {
      if (!idPattern.test(agentId)) return false;
      const dir = path.join(this.root, agentId);
      const spec = readJson<{ workspace?: string }>(path.join(dir, "spec.json"));
      if (spec?.workspace !== id) return false;
      const state = readJson<AgentState>(path.join(dir, "state.json"));
      // The worker releases owner.lock only after reaping its CLI. A terminal PID alone can
      // refer to an unrelated, reused process; missing/active state still fails closed.
      return existsSync(path.join(dir, "owner.lock")) || !state || !["completed", "failed", "stopped"].includes(state.phase);
    });
  }
  private assertIdle(ws: Workspace, except?: string): void {
    const occupied = this.occupied(ws.id).filter(id => id !== except);
    if (occupied.length) throw new Error(`Workspace ${ws.id} is occupied by ${occupied.join(", ")}. Wait for the current instance to finish; review and implementation cannot run together.`);
  }
  private async validate(ws: Workspace): Promise<void> {
    if (ws.status !== "ready") throw new Error(`Workspace is not ready (${ws.status}); inspect ${this.directory(ws.id)}`);
    if (ws.sync && ws.sync.status !== "applied") throw new Error("Unfinished or uncertain workspace synchronization; inspect the retained sync journal and backups before continuing");
    if (ws.integration && ws.integration.status !== "applied") throw new Error("Unfinished or uncertain integration; inspect before continuing");
    if ((await git(ws.path, ["config", "--type=bool", "--default=false", "core.sparseCheckout"])).toString().trim() === "true") throw new Error("Sparse checkout is unsupported for managed workspaces; inspect before continuing");
    const root = (await git(ws.path, ["rev-parse", "--show-toplevel"])).toString().trim();
    const common = (await git(ws.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).toString().trim();
    const parentCommon = (await git(ws.repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).toString().trim();
    if (realpathSync(root) !== realpathSync(ws.path) || realpathSync(common) !== ws.commonDir || realpathSync(parentCommon) !== ws.commonDir) throw new Error("Workspace repository identity changed; inspect before continuing");
    if ((await git(ws.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toString().trim() !== "HEAD") throw new Error("Workspace HEAD is attached to a branch; inspect before continuing. Managed operations require detached HEAD.");
    const head = (await git(ws.path, ["rev-parse", "HEAD"])).toString().trim();
    if (head !== ws.baseCommit) throw new Error(`Workspace HEAD changed from baseline ${ws.baseCommit} to ${head}; inspect rather than silently using another baseline.`);
  }
  private async regularTree(cwd: string, tree: string): Promise<void> {
    const entries = split(await git(cwd, ["ls-tree", "-rz", tree]));
    if (entries.some(entry => !entry.startsWith("100644 ") && !entry.startsWith("100755 "))) throw new Error("Submodules and symbolic links are unsupported in managed workspace snapshots; inspect and use a shared directory instead.");
  }
  private async noFilters(cwd: string, files?: string[], source?: string): Promise<void> {
    files ??= [...new Set(split(await git(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])))];
    if (!files.length) return;
    const attrs = split(await git(cwd, ["check-attr", ...(source ? [`--source=${source}`] : []), "-z", "--stdin", "filter"], Buffer.from(`${files.join("\0")}\0`)));
    for (let i = 0; i < attrs.length; i += 3) {
      if (attrs[i + 2] !== "unspecified" && attrs[i + 2] !== "unset") throw new Error(`Content filters (including Git LFS) are unsupported: ${attrs[i]}. No filter commands were run.`);
    }
  }
  async create(cwd: string, options: SnapshotOptions = {}): Promise<WorkspaceView> {
    const reason = options.includeUncommitted?.reason;
    if (options.includeUncommitted !== undefined && !reason?.trim()) throw new Error("Inheriting uncommitted changes requires an explicit authorization reason");
    return this.parentOperation("create", async () => {
      cwd = realpathSync(cwd);
      const repo = realpathSync((await git(cwd, ["rev-parse", "--show-toplevel"])).toString().trim());
      const prefix = path.relative(repo, cwd).split(path.sep).join("/");
      const parentCommit = (await git(repo, ["rev-parse", "--verify", "HEAD^{commit}"])).toString().trim();
      if ((await git(repo, ["config", "--type=bool", "--default=false", "core.sparseCheckout"])).toString().trim() === "true") throw new Error("Sparse checkout is unsupported for managed workspaces");
      await this.regularTree(repo, parentCommit);
      const names = split(await git(repo, ["ls-tree", "-rz", "--name-only", parentCommit]));
      await this.noFilters(repo, names, parentCommit);
      const parentChanges = await this.parentChanges(repo);
      const id = randomUUID(), location = path.join(`${repo}.worktrees`, id.slice(0, 8));
      const ws: Workspace = {
        version: 1, revision: 0, id, parentFile: this.parentFile, repo,
        commonDir: realpathSync((await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).toString().trim()),
        path: location, cwd: path.join(location, prefix), baseCommit: parentCommit, parentCommit,
        ...(reason ? { snapshotReason: reason.trim() } : {}), createdAt: Date.now(), status: "creating", parentChanges,
      };
      this.save(ws);
      try {
        if (reason) {
          const tree = await this.snapshot(repo, parentCommit, path.join(this.directory(id), "baseline"));
          ws.baseCommit = await this.internalCommit(repo, tree, parentCommit);
          this.save(ws);
        }
        if (prefix && (await git(repo, ["cat-file", "-t", `${ws.baseCommit}:${prefix}`])).toString().trim() !== "tree") throw new Error("Parent directory is not present in the selected baseline");
        if (existsSync(location)) throw new Error(`Worktree path already exists: ${location}`);
        await git(repo, ["worktree", "add", "--detach", location, ws.baseCommit]);
        ws.status = "ready"; this.save(ws);
        return { ...ws, changedFiles: [], occupiedBy: [] };
      } catch (error) {
        ws.status = "failed"; ws.error = (error as Error).message; this.save(ws);
        throw new Error(`${ws.error}; records retained at ${this.directory(id)}. Inspect ${location}; no automatic cleanup.`);
      }
    });
  }
  private async parentChanges(repo: string): Promise<string[]> {
    await this.noFilters(repo);
    return split(await git(repo, ["-c", "status.renames=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"])).map(entry => entry.slice(3));
  }
  private async internalCommit(repo: string, tree: string, parent: string): Promise<string> {
    if ((await git(repo, ["rev-parse", `${parent}^{tree}`])).toString().trim() === tree) return parent;
    return (await git(repo, ["-c", "commit.gpgSign=false", "commit-tree", tree, "-p", parent], Buffer.from("Internal managed-workspace baseline\n"), {
      GIT_AUTHOR_NAME: "Pi workspace snapshot", GIT_AUTHOR_EMAIL: "workspace@pi.invalid",
      GIT_COMMITTER_NAME: "Pi workspace snapshot", GIT_COMMITTER_EMAIL: "workspace@pi.invalid",
    })).toString().trim();
  }
  /** Raw cwd cannot bypass a known managed workspace's lease in this parent session. */
  assertShared(cwd: string): void {
    const resolved = realpathSync(cwd);
    const ws = this.records().find(ws => inside(ws.path, resolved));
    if (ws) throw new Error(`Use workspace: "${ws.id}" instead of cwd for this managed directory; raw cwd cannot bypass its workspace lease.`);
  }
  async runAgent<T>(id: string, agentId: string, action: (ws: Workspace, notice?: string) => Promise<T>, options: ResumeOptions = {}, beforeSync?: () => Promise<void>): Promise<T> {
    if (!idPattern.test(agentId)) throw new Error("Invalid agent id");
    if (options.baseline !== undefined && options.baseline !== "keep" && options.baseline !== "sync") throw new Error("Choose baseline keep or sync");
    if (options.includeUncommitted !== undefined && (options.baseline !== "sync" || !options.includeUncommitted?.reason?.trim())) throw new Error("Only sync may inherit uncommitted changes, with an explicit authorization reason");
    const run = () => locked(path.join(this.directory(id), "operation.lock"), `agent:${agentId}`, async () => {
      const ws = this.get(id);
      this.assertIdle(ws, options.baseline === "sync" ? undefined : agentId);
      await this.validate(ws);
      if (options.expectedRevision !== undefined && ws.revision !== options.expectedRevision) throw new Error("Workspace baseline changed during confirmation; inspect and choose again");
      const spec = readJson<AgentSpec>(path.join(this.root, agentId, "spec.json"));
      const stale = spec && (spec.workspaceBaseline?.revision ?? 0) !== ws.revision;
      if (!options.baseline && (stale || (!spec && ws.integration && !ws.continuation))) {
        throw new WorkspaceDecisionRequired("baseline", ws, `Workspace ${id} was integrated or its baseline changed. Choose baseline keep (current workspace, no parent sync) or sync (only with no unintegrated or staged changes). Resume the original instance deliberately before spawning new work here.`);
      }
      if (options.baseline === "sync") await this.synchronize(ws, options, beforeSync);
      if (options.baseline === "keep" && ws.integration) { ws.continuation = true; this.save(ws); }
      let notice: string | undefined;
      if (options.baseline || stale || (!spec && ws.integration)) {
        const folder = path.join(this.directory(id), "continuations", randomUUID());
        const tree = await this.snapshot(ws.path, ws.baseCommit, folder);
        const from = spec?.workspaceBaseline?.commit ?? ws.baseCommit;
        const changed = split(await git(ws.path, ["diff", "--no-renames", "--name-only", "-z", from, tree, "--"]));
        // A file created and then removed may be absent from both baseline commits, yet still
        // exist in this native session's memory. Include intervening journals, not just tree diff.
        const history: { revision?: number; status: string; changedFiles: string[] }[] = [
          ...(ws.integration ? [ws.integration] : []), ...(ws.sync ? [ws.sync] : []),
        ];
        for (const [kind, file] of [["integrations", "integration.json"], ["syncs", "sync.json"]]) {
          for (const entry of directories(path.join(this.directory(id), kind))) {
            const record = readJson<Integration>(path.join(this.directory(id), kind, entry, file));
            if (record) history.push(record);
          }
        }
        for (const record of history) if (record.status === "applied" && (record.revision === undefined || record.revision > (spec?.workspaceBaseline?.revision ?? -1))) changed.push(...record.changedFiles);
        const changedFiles = [...new Set(changed)].sort();
        notice = `Choice: ${options.baseline ?? "new review of continued work"}. Current workspace baseline: ${ws.baseCommit}; revision ${ws.revision}.\n`
          + (spec?.workspaceBaseline ? `Previous session baseline: ${spec.workspaceBaseline.commit}.\n` : "The previous session baseline is unknown; re-read all assigned files.\n")
          + `Files to re-read: ${changedFiles.length ? changedFiles.join(", ") : "no Git content changes"}.\n`
          + (ws.integration ? `Previously integrated snapshot: ${ws.integration.tree}. Review only the subsequent increment; earlier changes must not be reapplied.\n` : "")
          + "Session memory is not the current code. Re-read the affected files before editing or reviewing. keep never restores old files.";
        writeJson(path.join(folder, "decision.json"), { agentId, baseline: options.baseline, revision: ws.revision, baseCommit: ws.baseCommit, changedFiles, time: Date.now() });
      }
      return action(ws, notice);
    });
    return options.baseline === "sync" ? this.parentOperation("sync", run) : run();
  }
  private async synchronize(ws: Workspace, options: ResumeOptions, beforeSync?: () => Promise<void>): Promise<void> {
    const folder = path.join(this.directory(ws.id), "syncs", randomUUID());
    const currentTree = await this.snapshot(ws.path, ws.baseCommit, path.join(folder, "current"));
    const checkpoint = ws.integration?.tree ?? (await git(ws.path, ["rev-parse", `${ws.baseCommit}^{tree}`])).toString().trim();
    if (currentTree !== checkpoint) throw new Error("Workspace has unintegrated changes; sync would discard them. Integrate/review them first, or choose keep.");
    if ((await git(ws.path, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--name-only", "-z", ws.baseCommit, "--"])).length) throw new Error("Workspace has staged changes; inspect its index before sync. No files were changed.");
    const parentCommit = (await git(ws.repo, ["rev-parse", "HEAD"])).toString().trim();
    const changes = await this.parentChanges(ws.repo);
    const tree = await this.snapshot(ws.repo, parentCommit, path.join(folder, "parent"));
    if (options.expectedParentTree !== undefined && tree !== options.expectedParentTree) throw new Error("Parent changes differ from the confirmed snapshot; inspect and confirm again");
    const reason = options.includeUncommitted?.reason.trim();
    if (changes.length && !reason) throw new WorkspaceDecisionRequired("inherit", ws,
      `Sync would inherit uncommitted parent changes: ${changes.join(", ")}. Inspect and obtain authorization, then supply includeUncommitted.reason. No workspace files were changed.`, changes, tree);
    const prefix = path.relative(ws.path, ws.cwd).split(path.sep).join("/");
    if (prefix) {
      try {
        if ((await git(ws.path, ["cat-file", "-t", `${tree}:${prefix}`])).toString().trim() !== "tree") throw new Error("not a directory");
      } catch (error) { throw new Error(`The sync baseline does not contain the original child cwd ${ws.cwd}; choose keep or a new workspace. ${(error as Error).message}`); }
    }
    // The execution backend verifies the original session under this workspace's lock,
    // after Git/authorization checks but before changing the baseline. Not a cross-system transaction.
    await beforeSync?.();
    const nextBase = await this.internalCommit(ws.repo, tree, parentCommit);
    if (nextBase === ws.baseCommit && !ws.integration) return;
    const changedFiles = split(await git(ws.path, ["diff", "--no-renames", "--name-only", "-z", currentTree, tree, "--"]));
    const patch = await this.patch(ws.path, currentTree, tree);
    const patchFile = path.join(folder, "changes.patch"), backupFile = path.join(folder, "before.json"), indexBackupFile = path.join(folder, "index.before");
    writeFileSync(patchFile, patch, { mode: 0o600 });
    const before = this.backup(ws.path, changedFiles);
    writeJson(backupFile, before);
    if (patch.length) await git(ws.path, ["apply", "--check", "--whitespace=nowarn", "-"], patch);
    if (JSON.stringify(this.backup(ws.path, changedFiles)) !== JSON.stringify(before)) throw new Error("Workspace files changed during sync preflight; inspect before retrying");
    const index = (await git(ws.path, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).toString().trim();
    writeFileSync(indexBackupFile, readFileSync(index), { mode: 0o600 });
    writeJson(path.join(folder, "workspace.before.json"), ws);
    ws.sync = { status: "applying", revision: ws.revision + 1, previousBase: ws.baseCommit, nextBase, parentCommit, tree, time: Date.now(), patchFile, backupFile, indexBackupFile, changedFiles,
      ...(reason ? { reason } : {}), ...(ws.integration ? { previousIntegration: ws.integration } : {}) };
    const save = () => { writeJson(path.join(folder, "sync.json"), ws.sync); this.save(ws); };
    save();
    try {
      if (patch.length) await git(ws.path, ["apply", "--whitespace=nowarn", "-"], patch);
      await git(ws.path, ["read-tree", nextBase]);
      await git(ws.path, ["update-ref", "--no-deref", "HEAD", nextBase, ws.baseCommit]);
      ws.baseCommit = nextBase; ws.parentCommit = parentCommit; ws.snapshotReason = reason; ws.revision++;
      delete ws.integration; delete ws.continuation;
      ws.sync.status = "applied"; save();
    } catch (error) {
      ws.sync.status = "uncertain"; save();
      throw new Error(`Sync outcome is uncertain; inspect ${folder} before any further work. Files, old index, patch and baseline metadata are retained. ${(error as Error).message}`);
    }
  }
  async list(): Promise<WorkspaceView[]> {
    return Promise.all(this.records().map(async ws => {
      try {
        await this.validate(ws);
        await this.noFilters(ws.path);
        const tracked = split(await git(ws.path, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", ws.baseCommit, "--"]));
        const untracked = split(await git(ws.path, ["ls-files", "--others", "--exclude-standard", "-z"]));
        return { ...ws, changedFiles: [...new Set([...tracked, ...untracked])], occupiedBy: this.occupied(ws.id) };
      } catch (error) { return { ...ws, changedFiles: [], occupiedBy: this.occupied(ws.id), error: (error as Error).message }; }
    }));
  }
  private async snapshot(cwd: string, baseline: string, folder: string): Promise<string> {
    if ((await git(cwd, ["config", "--type=bool", "--default=false", "core.sparseCheckout"])).toString().trim() === "true") throw new Error("Cannot snapshot a sparse checkout; absent files are not confirmed deletions");
    if ((await git(cwd, ["ls-files", "--unmerged", "-z"])).length) throw new Error("Cannot snapshot an unmerged index; resolve and review the conflicts first");
    await this.noFilters(cwd);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const env = { GIT_INDEX_FILE: path.join(folder, "index") };
    await git(cwd, ["read-tree", baseline], undefined, env);
    await git(cwd, ["add", "-A", "--", "."], undefined, env);
    const tree = (await git(cwd, ["write-tree"], undefined, env)).toString().trim();
    await this.regularTree(cwd, tree);
    return tree;
  }
  private patch(cwd: string, from: string, to: string): Promise<Buffer> {
    return git(cwd, ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", from, to, "--"]);
  }
  private backup(repo: string, names: string[]): { path: string; content: string | null; mode?: number }[] {
    return names.map(name => {
      const file = path.resolve(repo, name);
      if (!inside(repo, file) || file === repo || name.split(/[\\/]/).some(part => part.toLowerCase() === ".git")) throw new Error(`Unsafe patch path: ${name}`);
      let current = repo;
      for (const part of path.relative(repo, file).split(path.sep)) {
        current = path.join(current, part);
        try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Symbolic-link patch path is unsupported: ${name}`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      try {
        const stat = lstatSync(file);
        if (!stat.isFile()) throw new Error(`Patch destination is not a regular file: ${name}`);
        return { path: name, content: readFileSync(file).toString("base64"), mode: stat.mode };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: name, content: null };
        throw error;
      }
    });
  }
  private async parentOperation<T>(name: string, action: () => Promise<T>): Promise<T> {
    // Snapshots, synchronization and integration must see a stable parent, even across managers.
    const previous = parentOperations.get(this.root) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => locked(path.join(this.root, "workspaces", "integration.lock"), name, async () => {
      if (this.records().some(ws => (ws.integration && ws.integration.status !== "applied") || (ws.sync && ws.sync.status !== "applied"))) throw new Error("An unfinished or uncertain integration/sync requires inspection before changing or snapshotting parent state");
      return action();
    }));
    parentOperations.set(this.root, task);
    try { return await task; }
    finally { if (parentOperations.get(this.root) === task) parentOperations.delete(this.root); }
  }
  async integrate(id: string): Promise<IntegrationResult> {
    return this.parentOperation("integrate", () => locked(path.join(this.directory(id), "operation.lock"), "integrate", () => this.apply(id)));
  }
  private async apply(id: string): Promise<IntegrationResult> {
    const ws = this.get(id);
    this.assertIdle(ws);
    await this.validate(ws);
    const folder = path.join(this.directory(id), "integrations", randomUUID());
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const tree = await this.snapshot(ws.path, ws.baseCommit, folder);
    if (ws.integration?.tree === tree) return { workspace: id, status: "already_integrated", patchFile: ws.integration.patchFile, changedFiles: ws.integration.changedFiles };
    if (ws.integration && !ws.continuation) throw new Error("An already integrated workspace has changed without explicit continuation; inspect before integrating.");
    const from = ws.integration?.tree ?? ws.baseCommit;
    if (ws.integration?.checkpointFile) {
      // JSON tree IDs do not keep Git objects alive. Rebuild from the protected baseline
      // in a private index, then verify identity before computing the next increment.
      const env = { GIT_INDEX_FILE: path.join(folder, "checkpoint.index") };
      try {
        const checkpoint = readFileSync(ws.integration.checkpointFile);
        await git(ws.path, ["read-tree", ws.baseCommit], undefined, env);
        if (checkpoint.length) await git(ws.path, ["apply", "--cached", "--whitespace=nowarn", "-"], checkpoint, env);
        const restored = (await git(ws.path, ["write-tree"], undefined, env)).toString().trim();
        if (restored !== from) throw new Error(`Restored tree ${restored} differs from ${from}`);
      } catch (error) { throw new Error(`Cannot restore integration checkpoint; parent files were not changed. Inspect ${ws.integration.checkpointFile}. ${(error as Error).message}`); }
    }
    const patch = await this.patch(ws.path, from, tree);
    if (!patch.length) return { workspace: id, status: "no_changes", changedFiles: [] };
    const changedFiles = split(await git(ws.path, ["diff", "--no-renames", "--name-only", "-z", from, tree, "--"]));
    await this.noFilters(ws.repo, changedFiles);
    const patchFile = path.join(folder, "changes.patch"), backupFile = path.join(folder, "before.json"), checkpointFile = path.join(folder, "checkpoint.patch");
    writeFileSync(patchFile, patch, { mode: 0o600 });
    writeFileSync(checkpointFile, ws.integration ? await this.patch(ws.path, ws.baseCommit, tree) : patch, { mode: 0o600 });
    const before = this.backup(ws.repo, changedFiles);
    writeJson(backupFile, before);
    try { await git(ws.repo, ["apply", "--check", "--whitespace=nowarn", "-"], patch); }
    catch (error) { throw new Error(`Integration conflict; parent files were not changed. ${(error as Error).message}. Patch retained at ${patchFile}`); }
    if (JSON.stringify(this.backup(ws.repo, changedFiles)) !== JSON.stringify(before)) throw new Error("Parent files changed during preflight; nothing was applied. Coordinate external writers before retrying.");
    if (ws.integration) writeJson(path.join(path.dirname(ws.integration.patchFile), "integration.json"), ws.integration);
    ws.integration = { status: "applying", revision: ws.revision + 1, tree, time: Date.now(), patchFile, checkpointFile, backupFile, changedFiles };
    this.save(ws);
    try {
      await git(ws.repo, ["apply", "--whitespace=nowarn", "-"], patch);
      ws.integration.status = "applied"; ws.revision++; delete ws.continuation;
      writeJson(path.join(folder, "integration.json"), ws.integration); this.save(ws);
    } catch (error) {
      ws.integration.status = "uncertain"; this.save(ws);
      throw new Error(`Integration outcome is uncertain; do not retry automatically. Inspect ${patchFile} and ${backupFile}. ${(error as Error).message}`);
    }
    return { workspace: id, status: "applied", patchFile, changedFiles };
  }
}
