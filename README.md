# pi-cli-subagents

A lightweight Pi extension for delegating work to real, reusable Pi CLI sessions. The parent agent chooses what to delegate; the extension manages execution and lifecycle, and a bundled skill guides delegation.

**Status: managed workspaces, authorized uncommitted-state snapshots, explicit baseline continuation and safe synchronization are implemented with deterministic tests.** The initial create → parallel implementation → independent review → integration loop also has real Pi RPC acceptance, as does phase 1 instance recall after reopening. Real Pi RPC acceptance also covers authorized snapshot inheritance, original-worker sync continuation, and original-reviewer keep continuation. Real-terminal baseline dialogs and arbitrary crash/I/O recovery are unverified; non-Pi CLI adapters are not implemented. This is not a general production-readiness claim.

## Scope

- Dispatch independent Pi CLI sessions asynchronously, send further instructions, inspect instances, stop work, and receive reports.
- Preserve the agent ID and native session across turns. Finished CLI processes may exit; later instructions resume the original session, never a silent replacement.
- Recover which instance handled which task from persisted history, so a compacted or reopened parent session does not have to remember it.
- Keep accepted child work running when the parent Pi exits. Results are saved and replayed when the original persistent parent session returns.
- Let the parent choose a shared directory or explicitly create a managed worktree. A worker and its independent reviewer use the same worktree in separate conversations, one active instance at a time.
- Inherit CLI model and permission configuration unless a role overrides the model. Report unresolved interactions instead of silently approving them.

The current version targets **Pi → Pi**. It does not introduce a workflow DSL, remote service, web dashboard, nested delegation, or token budgeting. The lifecycle takes inspiration from Paseo; live child navigation takes inspiration from tintinweb/pi-subagents. Later work covers Codex and other CLI adapters with their lifecycle and permission mapping.

## Development and local loading

Requires Node.js >=22.19 and an installed, configured Pi CLI.

```bash
npm ci
npm test

# From the project you want the agents to work in:
pi --extension /absolute/path/to/pi-cli-subagents/dist/index.js \
   --skill /absolute/path/to/pi-cli-subagents/skills/delegate-cli-agents
```

These command-line flags do not modify global settings. For project-level loading, run `pi install --local /absolute/path/to/pi-cli-subagents` from the target project and review its trust prompt yourself. This writes `.pi/settings.json`; relative package paths resolve from that settings file. Rebuild and reload Pi after changing the extension.

`dist/` is generated locally and ignored by Git. `prepack` builds it for packaging. Disposable demonstration tasks, raw sessions, and local acceptance drivers are not shipped.

## Agent tools

| Tool | Purpose |
| --- | --- |
| `create_workspace` | Create a detached worktree from HEAD, or explicitly inherit authorized working files through an internal baseline commit. |
| `integrate_workspace` | Apply an idle workspace's changes to its original parent directory without committing or changing the index. |
| `spawn_agent` | Start an `explore`, `worker`, `reviewer`, or custom role with either `cwd` or a managed `workspace` ID. |
| `send_input` | Steer, queue a `followUp`, or resume the original session; choose `baseline: "keep"` / `"sync"` when its workspace baseline needs confirmation. |
| `list_agents` | List this parent's instances with each one's earlier assignments and outcomes, roles, results, errors, and pending questions. |
| `close_agent` | Stop active work without deleting the session or its history. |
| `list_pending_permissions` | Inspect unresolved requests from subagents owned by this parent session. |
| `respond_to_permission` | Send one explicit, reasoned decision for a current request. |

The parent must have a persistent session; `--no-session` cannot own subagents. Prompt acceptance is not completion. The final report records whether the run succeeded, failed, stopped, or needs a response. **Do not poll `list_agents` for completion**: a `steer` report wakes the original parent at the next safe model boundary. Successes arriving within two seconds of the first success share one report; failures, pending interactions, unreachable workers, and inactivity reminders flush outstanding successes immediately. Reports include each full instance ID and the child's result/error, clipped per instance when long with an explicit pointer to `list_agents` or `/agents` and the raw log. A running child with no recorded activity for 15 minutes triggers one non-terminal reminder per run; this does not stop or restart it. Delivery is retried until the parent session contains the report receipt, so a crash at the delivery boundary may repeat a notification rather than lose it. Inspect `list_agents` or `/agents` for diagnosis, logs and native session details.

## Managed workspaces

Call `create_workspace({})` from the parent repository. It returns an ID, `path`, `cwd`, exact `baseCommit`, source `parentCommit`, and `parentChanges`. By default it does not inherit dirty files. To inherit them, explicitly pass `includeUncommitted: { reason: "…" }` after inspecting and obtaining authorization for **all** current parent changes. This snapshots working-file contents (not a separate staged version) into an internal Git commit, without updating the parent's branch, HEAD or index. `snapshotReason` records the reason; ignored untracked files are excluded. The plugin does not infer that unrelated edits belong to the task.

The path is `<repo>.worktrees/<eight-character-ID>/`, beside the repository; the child `cwd` is the corresponding subdirectory in the selected baseline. Each workspace belongs to the original persistent parent session. Creation does not install dependencies or force project trust. Prepare dependencies within the task's authorization; do not assume the main directory's `node_modules` is available.

A typical sequence is:

```text
create_workspace({})                                      → workspace ID
spawn_agent({ role: "worker", task: "…", workspace: ID })   → implementer ID
[receive completion report]
spawn_agent({ role: "reviewer", task: "…", workspace: ID }) → independent reviewer ID
[receive review; send_input to the original worker if fixes are needed]
integrate_workspace({ workspace: ID })
[verify the integrated result in the main directory]
```

- **Isolation and leases:** one independently integrable change per workspace. Only one instance can run there at a time, regardless of role. Another instance's starts, messages/resumes, and integration are refused while it is occupied. This includes the TUI and inline composer. Different workspaces can run concurrently. A known managed directory cannot bypass the lease by being passed as raw `cwd`. Worktrees isolate files, not OS permissions: coordinate humans, shared-directory agents and external tools yourself.
- **Baselines and continuation:** after integration or another instance's sync, `send_input` requires a deliberate baseline choice. `keep` retains the **current workspace files**; it does not restore what the native session remembers or import new parent changes. `sync` updates an idle workspace from the parent's current working-file snapshot. It requires no unintegrated content, no staged changes, an intact original session, and preservation of the original child `cwd`. Dirty parent files require `includeUncommitted.reason`, including when they came from prior integration. Sync changes only the child's detached HEAD and index, not the parent's. Each instance records its acknowledged baseline; old reviewers must also acknowledge another instance's sync. Continuation adds a baseline/file-change notice to the native prompt, including intervening deletions, and requires re-reading affected files.
- **Integration:** use only after reviewing the actual changes within the user's authorization. The plugin does not enforce reviewer roles or approval policy. It snapshots the child's working files using a separate index, includes non-ignored new files and intended tracked deletions, archives a binary-capable patch, and applies only to the parent's working files. Real indexes, HEADs and branches are untouched. Same-runtime integration, creation and sync operations for a parent queue; independent processes use an exclusive parent-state lock and fail closed when busy. After deliberate `keep` continuation, integration applies only the increment after the last integrated snapshot, not the whole original patch. Brief reviewers to assess that increment and any new untracked files. An unchanged previously integrated snapshot returns `already_integrated` without rewriting the main directory, even if the human has since edited it.
- **Failure handling:** patch conflicts are checked before any parent-file writes. A patch, exact affected-file backups, and an `applying` journal are saved before application. Filesystem I/O failure or a crash is **not an atomic transaction guarantee**: it may leave partial application. An unfinished/uncertain journal blocks further parent-state operations, and stale operation/worker locks are never automatically reclaimed. Sync also retains the old workspace record (`workspace.before.json`), index (`index.before`), changed-file backups and the old/new baseline IDs before writing. Inspect these records and files before recovery; the plugin does not roll back, reset or discard changes automatically. External writers must remain paused during snapshot/integration/sync.
- **Supported repositories:** requires Git with `check-attr --source` (verified with Git 2.50.1). Sparse checkouts, snapshots of unmerged indexes, trees containing submodules or symlinks, and content filters including Git LFS are refused. Git hooks, configured fsmonitor hooks, and external diff/textconv commands are not run by the workspace operations. Large Git outputs exceeding the bounded command buffer fail rather than silently truncate.

Related follow-up examples (use the original instance ID):

```text
send_input({ id: ID, message: "…", baseline: "keep" })
send_input({ id: ID, message: "…", baseline: "sync",
             includeUncommitted: { reason: "User authorized these parent changes" } })
```

In the TUI, the baseline selector offers keep/sync; sync asks before inheriting listed dirty parent files. Cancellation sends no task. The inline composer closes its overlay before opening these dialogs and carries the typed message with it. A changed workspace revision or parent snapshot during confirmation is rejected rather than silently broadening the confirmed operation. Human baseline decisions are recorded in the parent session.

`list_agents` includes each instance's `workspace` ID and acknowledged `workspaceBaseline`, plus a `workspaces` array with current paths, baselines, changed files, occupants and integration/sync records. Git queries happen on explicit workspace operations/listing, not in the 800 ms TUI status refresh. Workspace records, snapshots, patches and backups live in `<parent-session-file>.subagents/workspaces/` and may contain sensitive source content. They and the worktrees are retained; there is no cleanup tool.

For manual cleanup, first inspect `git -C <repo> worktree list` and `git -C <workspace-path> status`, and preserve any wanted changes. Only after explicit human authorization, `git -C <repo> worktree remove <workspace-path>` removes a clean worktree; do not add `--force` merely to bypass a refusal. Retained instance records will no longer be usable with a removed worktree.

## Instances, roles, and task history

A role is a template; an instance is a colleague with a stable identity and its own native Pi session. The same role can run as several instances at once, so lists identify each one by role plus the first eight characters of its ID, and detail views keep the full ID for commands.

`list_agents` reports each instance's `history`: the assignments it already handled, oldest first, each with the task summary, its run ID, its start time, and its outcome. `runCount` is the total number of runs, and `history` holds the five most recent. A run that ended without a result report is reported as `unknown` rather than being assumed successful. This is how the parent recovers *who did what* after its own context is compacted or the session is reopened, instead of relying on recall. Reuse an instance when the new task depends on what it already learned; start a new one for unrelated work. Session memory is not a current view of the code: when earlier work has since been integrated or changed, the follow-up task must say what to re-read.

Direct human actions in the TUI — messaging or resuming an instance, answering its pending request, or stopping it — are appended to the parent session as `[Human → subagent …]` entries. They do not start a parent turn, so routine additions do not interrupt sibling work, but the parent sees them in context and can re-check its plan. They are instructions to one instance, not wider authorization.

## Terminal UI

Two independent surfaces: a status summary above the editor and a navigable roster below it.

The status widget above the editor shows role, short ID, phase, recent tool activity, and elapsed time. Waiting requests take priority. Active instances have a second activity line; finished instances collapse to one line, linger for 30 seconds, and then disappear. No widget space is reserved when there is nothing to show.

### Roster below the editor

While any child is active, a compact roster stays visible below the editor: `main` followed by each running child, plus recently finished ones for a few seconds. With an empty prompt, press **Down** (or **Left**) to move focus into it, then **Up/Down** to select, **Enter** to open the selected child's live conversation, and **Esc** to return to the prompt. Typing is never intercepted: the roster only reacts to arrow keys when the prompt editor has focus and its text is empty, so it stays out of the way of other dialogs and of normal input.

### `/agents` and the shortcut

Press **Ctrl+Alt+A** from Pi's main editor to open the full agent roster while children are running; no need to wait for them to finish or send the main model a prompt. `/agents` opens the same roster when commands are available. Use **Up/Down** to select any instance and **Enter** (or **v**) to open its live conversation immediately; **i** opens its summary. The summary contains the task, latest activity, result or error, native session, log path, and pending request.

| Key in the summary | Action |
| --- | --- |
| `v` | Open the live conversation viewer. |
| `s` | Message an active child or resume a finished child's original session. |
| `x` | Stop an active child, after confirmation. |
| `r` | Answer a pending interaction as the human user. |
| `Esc` / `Left` | Return to the list. |
| `q` | Close the panel. |

The viewer is non-blocking with respect to child execution: closing it does not stop a child. It renders the child's own conversation in Pi's visual language: a bordered frame that uses your input box's border color, a header with role, short ID, phase and elapsed time, user prompts on their message background, assistant replies as Markdown, and tool calls with their arguments and output (errors highlighted, long output clipped with a remaining-lines note).

Scrolling follows Pi's transcript bindings, including user overrides from `keybindings.json`: **PageUp/PageDown** (or `tui.altScreen.pageUp/pageDown`) page through, **Home/End** jump to the top or back to live output, and **Up/Down** or **Shift+Up/Shift+Down** scroll a line at a time. Scrolling up pauses automatic following; returning to the end resumes it. The footer shows the follow state, total lines and scroll percentage, and the header shows the child's reported token usage and model.

**Enter** opens an inline message composer without leaving the viewer: type, then **Enter** to send and **Esc** to cancel. A running child receives the message after its current tool; a finished child starts a new turn in its original session (that takes longer, and the footer reports the result). Unreachable instances cannot be messaged, because the manager refuses to resume a session whose owner is unknown.

Keyboard shortcuts apply while Pi's main editor has focus, not during another modal dialog.

- New output is followed automatically. **Up/Down** or **Page Up/Page Down** scroll; scrolling up pauses following.
- **Home** goes to the oldest retained entry; **End** returns to live following.
- **s** messages/resumes the selected instance; **x** requests a confirmed stop. **Esc/q** returns to the list.
- Viewing and closing the UI never starts, stops, or approves a child by itself.

History is bounded to the latest 300 entries, with up to 24,000 characters per text/input and a 4 MiB limit per raw JSONL record. Clipping and malformed records are reported; original logs remain available. Large histories load progressively. This is not a byte-for-byte replacement for the native session or raw event log.

Panels use temporary overlays, not a replacement editor. They are TUI-only; RPC and non-interactive modes keep the eight agent/workspace tools. Actions can take time: an active send has a 35-second control timeout, a resume can take about 60 seconds including prior process release, and stopping can take 30 seconds. Acceptance timeouts require inspection, not blind retries.

## Custom roles

Built-ins are `explore` (investigate without changing project files), `worker` (implement and verify), and `reviewer` (assess someone else's changes). Override or add roles in:

- User: `~/.pi/agent/cli-subagents.roles.json`
- Trusted project: `.pi/cli-subagents.roles.json`

Project roles replace user roles with the same name; user roles replace built-ins. Replacements are whole role definitions, not field-by-field merges. `description` and `instructions` are required. `provider`, `model`, and `thinking` are optional. Allowed thinking values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (the selected model must support the value).

```json
{
  "tester": {
    "description": "Independently verify the implementation",
    "instructions": "Inspect the assigned changes and report reproducible issues. Do not modify source files."
  }
}
```

Role instructions are not a security sandbox. Per-role tool/skill restrictions are not implemented.

## Interactions and local data

Native Pi has no default permission-approval workflow. Other extensions can request interaction. Those requests enter `waiting`; the parent Pi may inspect them with `list_pending_permissions` and answer one current request with `respond_to_permission`, giving a reason. The parent must compare the requested action to the user's authorized task; ambiguous or out-of-scope requests should remain pending for the user. Approvals are per request, not permanent permission grants, and do not disable or reconfigure safety extensions. The human can still answer through `/agent-reply <agentId> <questionId>` or the panel. Decisions are recorded in the run's local `permissions.jsonl` next to the event log; a response being sent does not prove that the action later completed. This is a policy/interface boundary, **not OS isolation**: processes under the same user can access local control files.

Sessions, reports, and event logs live beside the parent session in `<parent-session-file>.subagents/`. They can contain sensitive task data; do not publish them. Control credentials are not included in tool results. Closing an instance does not delete these files.

If a worker is unreachable or an ownership lock remains, the extension refuses duplicate execution and requires inspection. It does not automatically reclaim stale locks or recover a crashed execution owner.

## Verification and limits

`npm test` builds the extension and runs deterministic tests without model calls. Tests cover protocol framing, lifecycle and original-session resume, role trust, report receipts, UI rendering, keyboard actions, transcript streaming, and cleanup. Managed-workspace tests use real temporary Git repositories and deterministic child CLIs: isolated parallel edits, independent review of uncommitted files, cross-controller leases, integration/conflict handling, CRLF/binary/deletion cases, index/HEAD preservation, and tool/TUI rejection of stale continuation. Additional deterministic tests cover authorized snapshot inheritance, incremental keep continuation, synchronization without losing unintegrated/staged/ignored data, old-instance notices across multiple syncs, preserved native session IDs, and TUI confirmation/cancellation with changing parent content. CLI cleanup checks distinguish the original instance's command line from an unrelated reused PID. `npm run check` checks TypeScript.

The local opt-in managed-workspace driver (`.test-output/phase2-real-flow.mjs`, ignored by Git) exercised one real Pi parent, two concurrent real workers, and two independent real reviewers. The parent used `create_workspace` twice and `integrate_workspace` twice, progressing through four terminal notifications without completion polling. Each worker changed only its own assigned operation, each reviewer inspected that workspace without edits, and the main sandbox passed both checks after integration while each worktree retained the other operation's original code. The external observer additionally verified review-time exclusion, duplicate-integration no-op behavior, and refusal of post-integration continuation without a baseline choice against those real instances. A separate read-only audit checked native session/model identities, actual tool calls, unchanged sandbox HEAD/refs/index, unchanged plugin files during the run, and release of all owned processes. These checks do not constitute real-terminal or crash-recovery acceptance; conflict/CRLF coverage comes from the deterministic Git tests.

The separate local opt-in `.test-output/phase2-real-sync.mjs` driver exercised authorized uncommitted-state inheritance, implementation/review/integration, a later parent-input change, and continuation of the **same** worker with `baseline: "sync"` followed by the **same** reviewer with `baseline: "keep"`. Both native session IDs were preserved across two runs, and both instances actually re-read the changed inputs before acting. The real parent used the managed tools for both integrations, received four completion notifications without polling, and verified the updated behavior. Audits checked the real read/edit calls, unchanged parent HEAD/refs/staged index, unchanged plugin code during the run, and release of all owned processes. Other negative paths remain covered by deterministic tests, not arbitrary live failure injection.

`node test/real-smoke.mjs` is an explicit opt-in real-model test; it normally makes two small calls and writes only to `.test-output/`. Local real Pi RPC acceptance also exercised a notification-driven implement → review → original-implementer continuation without `list_agents` polling. A persisted parent session was reopened after an offline child completion, with one delivered report and no duplicate on a second reopen. A real parent Pi handled a fixture child's ambiguous permission request without approving it; the human denied the request and the child still sent its final report. Temporary drivers, tasks and raw artifacts remain local.

The instance-history path has its own local driver (`.test-output/phase1-recall.mjs`, ignored by Git): one real parent dispatched two same-role workers with different tasks, exited, and a fresh process on the same session rebuilt the mapping from `list_agents` alone — resuming the correct instance by ID in its original native session while the other instance's run count stayed at one. It also caught a real defect during that check: a queued resume was briefly reported as finished, so `list_agents` now reports only runs the persisted state has acknowledged.

Automated component tests are not full terminal acceptance. A no-model Windows ConPTY smoke test also loaded the actual Pi TUI in regular and fullscreen modes: the below-editor roster, arrow-key focus, opening a running child's live conversation, tool arguments, streaming output, resizing, scrolling, closing and exiting all passed. Its child was a deterministic RPC fixture, not another model call. Real TUI permission dialogs, parent TUI exit/replay, every terminal/key protocol and theme, and execution-owner crash recovery are not comprehensively verified. TUI approval is an optional compatibility path, not a blocker for the core Pi-to-Pi collaboration test. Safety-guard false positives remain unresolved; the parent-delegated decision path has deterministic protocol tests, but its real-model authorization behavior is not yet fully verified.

## References

[Paseo](https://github.com/getpaseo/paseo) informs the lifecycle and orchestration goals. [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) informs the compact status and conversation-viewer interaction. This extension keeps its own Pi CLI process ownership and persistence model rather than importing their workflow systems.
