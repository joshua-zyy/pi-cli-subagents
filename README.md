# pi-cli-subagents

A lightweight Pi extension for delegating work to reusable CLI sessions. Pi is fully supported; Codex and Claude Code have native-protocol adapters with managed workspaces, single-action approvals and bounded conversation rendering. The parent agent chooses what to delegate; the extension manages execution and lifecycle, and a bundled skill guides delegation.

**Status: Pi and Codex managed workspaces, authorized uncommitted-state snapshots, explicit baseline continuation and safe synchronization are implemented with deterministic tests. The Codex app-server adapter, single-action approvals and conversation rendering are covered by deterministic fake-CLI tests. Isolated real Codex acceptance covers reviewed single-action command/file approvals, actual writes, independent review, integration and original-thread sync/keep continuation through AgentManager, with the recovery caveats below.** The initial create → parallel implementation → independent review → integration loop also has real Pi RPC acceptance, as does phase 1 instance recall after reopening. Real Pi RPC acceptance also covers authorized snapshot inheritance, original-worker sync continuation, and original-reviewer keep continuation. Real-terminal baseline dialogs and arbitrary crash/I/O recovery are unverified. Real-parent Pi → Codex orchestration, live-terminal interaction and broader Codex permission-failure paths remain unverified. Claude Code has deterministic adapter/workspace tests, no-model startup checks, and a recovered four-model-task acceptance covering real file approvals, original-session continuation and workspaces; real-parent/TUI acceptance remains unverified. This is not a general production-readiness claim.

## Scope

- Dispatch independent CLI sessions asynchronously, send further instructions, inspect instances, stop work, and receive reports. The Codex and Claude Code subsets are limited as described below.
- Preserve the agent ID and native session across turns. Finished CLI processes may exit; later instructions resume the original session, never a silent replacement.
- Recover which instance handled which task from persisted history, so a compacted or reopened parent session does not have to remember it.
- Keep accepted child work running when the parent Pi exits. Results are saved and replayed when the original persistent parent session returns.
- Let the parent choose a shared directory or explicitly create a managed worktree. A worker and its independent reviewer use the same worktree in separate conversations, one active instance at a time.
- Inherit CLI model and permission configuration unless a role overrides the model. Report unresolved interactions instead of silently approving them.

The tested full-workflow target remains **Pi → Pi**. Codex currently supports shared-directory or managed-workspace spawn, steer, close, same-thread resume, explicit keep/sync continuation, single-action command/file approvals and a bounded live conversation view. It does not introduce a workflow DSL, remote service, web dashboard, nested delegation, or token budgeting. The lifecycle takes inspiration from Paseo; live child navigation takes inspiration from tintinweb/pi-subagents. Claude Code supports spawn, close and original-session continuation, including keep/sync; active steering and follow-up delivery are explicitly refused. Real-parent Codex/Claude orchestration, terminal acceptance and additional backends remain separate work.

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
| `spawn_agent` | Start an `explore`, `worker`, `reviewer`, or custom role with either `cwd` or a managed `workspace` ID. Pi, Codex and Claude roles accept managed workspaces, including sequential mixed-CLI review. |
| `send_input` | Steer, queue a Pi-only `followUp`, or resume the original session; choose `baseline: "keep"` / `"sync"` when its workspace baseline needs confirmation. Codex running `followUp` and Claude running `steer`/`followUp` are refused, not silently reinterpreted. |
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

New integrations also retain `checkpoint.patch`, a binary-capable patch from the workspace baseline to the integrated snapshot. Before a later incremental integration, the plugin reconstructs that checkpoint in a private index and verifies its tree ID. Git pruning therefore does not erase the increment's starting point; neither repository's real index, HEAD or refs need to change. Missing, malformed or mismatched checkpoint data blocks that incremental integration before parent-file writes. Legacy records without `checkpointFile` still require their original Git objects and gain the retained patch on their next successful integration; already-pruned legacy checkpoints are not guessed from subsequently changed files. Retained patches are not a full repository backup: the workspace baseline must still exist.

Related follow-up examples (use the original instance ID):

```text
send_input({ id: ID, message: "…", baseline: "keep" })
send_input({ id: ID, message: "…", baseline: "sync",
             includeUncommitted: { reason: "User authorized these parent changes" } })
```

For Codex sync, the plugin checks the original `threadId`, `sessionId`, working directory and idle/unloaded status through a metadata-only `thread/read`, under the workspace lease and after Git/authorization preflight. It does not resume a thread or start a model turn during this check, and closes the check process before changing workspace files. A missing, changed or uninspectable native thread blocks sync; logs remain in the instance directory as `preflight-*.jsonl`. The worker then resumes the **same** thread using its pinned `CODEX_HOME`. This is not a transaction across Git and Codex: if sync applies but resume or submission fails, the applied sync journal and original native identity are retained, while the instance's acknowledged baseline stays unchanged. Inspect the failure, then explicitly choose keep or sync before retrying; do not undo files or create a replacement thread automatically. External native-session writers are not covered by the plugin's workspace lease.

In the TUI, the baseline selector offers keep/sync; sync asks before inheriting listed dirty parent files. Cancellation sends no task. The inline composer closes its overlay before opening these dialogs and carries the typed message with it. A changed workspace revision or parent snapshot during confirmation is rejected rather than silently broadening the confirmed operation. Human baseline decisions are recorded in the parent session.

`list_agents` includes each instance's `workspace` ID and acknowledged `workspaceBaseline`, plus a `workspaces` array with current paths, baselines, changed files, occupants and integration/sync records. Git queries happen on explicit workspace operations/listing, not in the 800 ms TUI status refresh. Workspace records, snapshots, patches and backups live in `<parent-session-file>.subagents/workspaces/` and may contain sensitive source content. They and the worktrees are retained; there is no cleanup tool.

For manual cleanup, first inspect `git -C <repo> worktree list` and `git -C <workspace-path> status`, and preserve any wanted changes. Only after explicit human authorization, `git -C <repo> worktree remove <workspace-path>` removes a clean worktree; do not add `--force` merely to bypass a refusal. Retained instance records will no longer be usable with a removed worktree.

## Instances, roles, and task history

A role is a template; an instance has a stable identity and its own native Pi/Claude session or Codex thread. The same role can run as several instances at once, so lists identify each one by role plus the first eight characters of its ID, and detail views keep the full ID for commands.

`list_agents` reports each instance's `history`: the assignments it already handled, oldest first, each with the task summary, its run ID, its start time, and its outcome. `runCount` is the total number of runs, and `history` holds the five most recent. A run that ended without a result report is reported as `unknown` rather than being assumed successful. This is how the parent recovers *who did what* after its own context is compacted or the session is reopened, instead of relying on recall. Reuse an instance when the new task depends on what it already learned; start a new one for unrelated work. Session memory is not a current view of the code: when earlier work has since been integrated or changed, the follow-up task must say what to re-read.

Direct human actions in the TUI — messaging or resuming an instance, answering its pending request, or stopping it — are appended to the parent session as `[Human → subagent …]` entries. They do not start a parent turn, so routine additions do not interrupt sibling work, but the parent sees them in context and can re-check its plan. They are instructions to one instance, not wider authorization.

The live monitor builds one agent snapshot per refresh and shares it with report delivery and both widgets; animation ticks only redraw it. Historical request/report text is cached per controller as task summaries and clipped results, with file identity, size, modification time and change time checked before reuse. Directory and metadata scans still occur, and reopening a controller rebuilds its cache from disk. Ownership, runtime state, pending questions and control endpoints are not served from this historical cache; actions re-read live records.

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

**Enter** opens an inline message composer without leaving the viewer: type, then **Enter** to send and **Esc** to cancel. A running Pi/Codex child receives steering at its native boundary; active Claude messages are refused. A finished child starts a new turn in its original session (that takes longer, and the footer reports the result). Unreachable instances cannot be messaged, because the manager refuses to resume a session whose owner is unknown.

Keyboard shortcuts apply while Pi's main editor has focus, not during another modal dialog.

- New output is followed automatically. **Up/Down** or **Page Up/Page Down** scroll; scrolling up pauses following.
- **Home** goes to the oldest retained entry; **End** returns to live following.
- **s** messages/resumes the selected instance; **x** requests a confirmed stop. **Esc/q** returns to the list.
- Viewing and closing the UI never starts, stops, or approves a child by itself.

History is bounded to the latest 300 entries, with up to 24,000 characters per text/input and a 4 MiB limit per raw JSONL record. Clipping and malformed records are reported; original logs remain available. Large histories load progressively. This is not a byte-for-byte replacement for the native session or raw event log.

Panels use temporary overlays, not a replacement editor. They are TUI-only; RPC and non-interactive modes keep the eight agent/workspace tools. Actions can take time: an active send has a 35-second control timeout, a resume can take about 60 seconds including prior process release (sync adds Git checks and up to 30 seconds for Codex metadata preflight), and stopping can take 30 seconds. Acceptance timeouts require inspection, not blind retries.

## Custom roles

Built-ins are `explore` (investigate without changing project files), `worker` (implement and verify), and `reviewer` (assess someone else's changes). Override or add roles in:

- User: `~/.pi/agent/cli-subagents.roles.json`
- Trusted project: `.pi/cli-subagents.roles.json`

Project roles replace user roles with the same name; user roles replace built-ins. Replacements are whole role definitions, not field-by-field merges. `description` and `instructions` are required. Pi roles: `provider`, `model`, and `thinking` are optional. Codex roles require `"cli": "codex"` and an explicit `model`; optional `effort` is one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`. Pi-only `provider`/`thinking` cannot appear on a Codex role. Allowed Pi thinking values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (the selected model must support the value).

```json
{
  "tester": {
    "description": "Independently verify the implementation",
    "instructions": "Inspect the assigned changes and report reproducible issues. Do not modify source files."
  }
}
```

A Codex role can be configured in the same trusted JSON file, for example:

```json
{
  "codex-worker": {
    "cli": "codex",
    "description": "Execute a task in Codex",
    "instructions": "Complete only the authorized task and report what you verified.",
    "model": "YOUR_AVAILABLE_CODEX_MODEL",
    "effort": "medium"
  }
}
```

On Windows, the extension launches the `@openai/codex` Node entrypoint found on `PATH` with `shell:false`, rather than launching an npm `.cmd` shim. It pins the resolved `CODEX_HOME` (or the default `~/.codex`) to the instance for later turns, inherits existing native login and policies, and never changes global configuration. No model fallback or permission downgrade occurs if a request fails. Codex native `threadId` is the resume target; `sessionId` is a separate session-tree identity. `close_agent` does not archive or delete threads.

**Current Codex limits:** Running `followUp` remains unsupported; use steer or wait for completion before resuming. The Codex conversation viewer reads its existing native JSON-RPC event log without contacting the CLI; it shows bounded messages, command/file activity, and cumulative reported token usage. Unknown/broad Codex interactions fail closed, rather than being converted into a session-wide authorization. The protocol is checked against Codex CLI 0.159.0. Check the actual CLI version and inherited `CODEX_HOME` when availability differs from a separate Codex application; the plugin never switches accounts silently. A Codex role's instructions and the inherited sandbox are not OS isolation. Per-role tool/skill restrictions are not implemented.

### Claude Code

Configure a Claude role in the same trusted roles file:

```json
{
  "claude-worker": {
    "cli": "claude",
    "description": "Execute a task in Claude Code",
    "instructions": "Complete only the authorized task and report what you verified."
  }
}
```

Requires native Claude Code **2.1.283 or newer 2.1.x** on PATH (`claude.exe` on Windows). `model` is optional and otherwise follows native Claude configuration; Pi `provider`/`thinking` and Codex `effort` are rejected. The adapter speaks stream-json directly; the version-matched Agent SDK is a protocol reference, not an execution dependency. It pins `CLAUDE_CONFIG_DIR` (default `~/.claude`) and checks the original native session ID and cwd on continuation. It never uses `--continue`, `--fork-session`, or permission-bypass flags. The CLI maintains its own session/configuration state; the plugin does not reconfigure global model or permission settings.

- **Identity and completion:** handshake requires an idle initialization and working-directory confirmation. It returns the requested native target; task acceptance waits for the first `system/init` to verify that exact ID and cwd. Pre-prompt identity notifications such as `commands_changed` are optional, including on resume. Handshake alone does not create resumable history: continuation requires exactly one original JSONL session with verifiable identity/cwd metadata. A result must match the submitted message UUID, have a valid empty queue boundary, and leave no known non-ambient background tasks before success is reported. Local stream-json may omit `session_state_changed` entirely; that optional event is not a completion gate. API errors are failures even when the result subtype is `success`.
- **Approvals:** only native `can_use_tool` requests bound to an observed current tool call are answerable. Choices are `Deny once`, `Approve once`, and `Cancel turn`; denial is the initial selection. The exact native input is preserved and no `updatedPermissions` are returned. Rule-forced or manual-only approval requires the human UI; the parent may deny/cancel but cannot approve it. Dedicated user dialogs, nested-agent approvals, unknown/unscoped requests and oversized details fail closed. Already permitted native actions do not become new approval prompts. A successful stdio reply is not proof the tool executed, and an attempted/expired reply cannot be sent again.
- **Continuation and workspaces:** running `steer` and `followUp` are not implemented; wait for completion and send to the same instance. Stop uses native interrupt and cancels the native queue when the capability is advertised, with process-tree cleanup as fallback. Keep/sync reuse the existing workspace lease and journals. Before sync changes files, a bounded read-only native-file check verifies the original ID and cwd without launching Claude. It does not prove an external Claude process is idle: coordinate external session/file writers yourself. If sync applies and resume fails, retain the original identity, applied journal and previous acknowledged baseline; never roll back or replace the session automatically.
- **Evidence and display:** deterministic fixtures cover adapter, manager, approvals, transcripts and real-Git workspaces. Two isolated checks against the installed CLI verified raw and adapter-driven no-model initialization, identity echo and clean exit, with no user messages or requests to the local blocked endpoint. Those startup checks alone do not verify model execution. A subsequent isolated real run used the existing default model mapping (`opus` → `claude-opus-5[1m]`) for four actual model tasks, with five startup attempts: one attempt failed during initialization before a user message was submitted. Two separately reviewed single-action Edit approvals changed only the assigned file, both original sessions recalled distinct markers before reading files, and eight successful Read calls covered current inputs. Final integration passed `[7,17,27]` with unchanged parent HEAD/refs/index and original global configuration, no retained credential values, and no remaining owned processes. This was Node → AgentManager → real Claude Code, with `default` permissions, only Read/Edit/Write, and hooks/MCP disabled in the isolated profile—not an acceptance of arbitrary inherited profiles or a real parent Pi/TUI. The first native turn completed but the old adapter waited for an absent state event and was stopped; a later initialization-only failure exposed the optional pre-prompt identity event. Both were fixed with failing-first regressions before continuing the same instances; their failed/stopped records remain intact. This is recovered capability evidence, not four uninterrupted successful plugin runs. The viewer renders the native conversation and reported usage snapshots; native accounting may reset when prior totals were not persisted, so these are not guaranteed lifetime totals or billing statements.

## Interactions and local data

Native Pi has no default permission-approval workflow; other extensions can request interaction. Codex's command and file-change approvals enter `waiting` only when the current thread/turn and exact command/cwd or proposed file changes fit in the bounded request payload. Inspect the raw log if the TUI cannot show every line; otherwise deny. `respond_to_permission` and `/agent-reply` support only per-request accept, decline or cancel. When Codex offers accept/cancel but no decline-and-continue, the request is an explicit selection: `value: "Approve once"` or `value: "Cancel turn"` (or `cancelled: true`). The dialog includes the command details; cancellation ends the native turn, and `confirmed: false` is not silently translated into cancellation. Session-wide approvals, persistent policy amendments, `writeStdin`, `grantRoot`, and additional filesystem/network permissions are not offered; only single-action decisions actually offered by the native server may be returned. Unsupported/unscoped requests are rejected and fail the run. An unanswered Codex request resolved by the native server is removed; a response with uncertain native resolution cannot be sent twice. Across supported CLIs, answerable requests enter `waiting`; the parent Pi may inspect them with `list_pending_permissions` and answer one current request with `respond_to_permission`, giving a reason. The parent must compare the requested action to the user's authorized task; ambiguous or out-of-scope requests should remain pending for the user. Approvals are per request, not permanent permission grants, and do not disable or reconfigure safety extensions. The human can still answer through `/agent-reply <agentId> <questionId>` or the panel. Decisions, including the exact selected option for selection dialogs, are recorded in the run's local `permissions.jsonl` next to the event log; a response being sent does not prove that the action later completed. This is a policy/interface boundary, **not OS isolation**: processes under the same user can access local control files.

Sessions, reports, and event logs live beside the parent session in `<parent-session-file>.subagents/`. They can contain sensitive task data; do not publish them. Control credentials are not included in tool results. Closing an instance does not delete these files.

If a worker is unreachable or an ownership lock remains, the extension refuses duplicate execution and requires inspection. It does not automatically reclaim stale locks or recover a crashed execution owner.

## Verification and limits

`npm test` builds the extension and runs deterministic tests without model calls. Codex tests use a fake JSON-RPC app-server in a unique `.test-output/` home: native thread/session/turn identity, fast and foreign events, empty-summary recovery, same-thread continuation, running steer, unsupported follow-up, interrupt, scoped command/file approvals, denial/cancel, native resolution and timeout races, cumulative usage, bounded transcript output, parent-controller exit and old Pi-record compatibility. These fixtures alone do not verify real Codex availability, permission enforcement, real-terminal dialogs or working-directory side effects. A separate local opt-in read-only Codex turn completed with the explicitly selected model and no tools, and the resulting native log parsed as one user message, one assistant answer and cumulative token usage. That text-only probe by itself does **not** verify approval routing, writes, resume across processes, or the live TUI; the separate workspace evidence is described below. Tests cover protocol framing, lifecycle and original-session resume, role trust, report receipts, UI rendering, keyboard actions, transcript streaming, and cleanup. Managed-workspace tests use real temporary Git repositories and deterministic child CLIs: isolated parallel edits, independent review of uncommitted files, cross-controller leases, integration/conflict handling, CRLF/binary/deletion cases, index/HEAD preservation, and tool/TUI rejection of stale continuation. Additional deterministic tests cover authorized snapshot inheritance, incremental keep continuation, synchronization without losing unintegrated/staged/ignored data, old-instance notices across multiple syncs, preserved native session IDs, and TUI confirmation/cancellation with changing parent content. CLI cleanup checks distinguish the original instance's command line from an unrelated reused PID. `npm run check` checks TypeScript.

Codex-specific workspace tests use real temporary Git repositories and fake app-server processes: inherited snapshots and child cwd, parallel worktree writes, independent Pi/Codex review, keep/sync notices, missing/changed native threads before file changes, cross-process exclusion during preflight, and successful sync followed by failed resume without rollback or replacement. A separate no-model-call check against an existing isolated real Codex thread verified `initialize` → `initialized` → metadata-only `thread/read`, unchanged native transcript files and clean process exit, without copying credentials. This verifies native metadata preflight only, not real model-driven workspace writes or continuation. A later opt-in real workspace run stopped at its first read-command approval, before any successful command or file change: Codex offered accept/cancel but no decline. That trace exposed the adapter's overly strict decision check; deterministic adapter/worker/dialog regressions now cover this shape without offering its persistent policy-amendment option. A supervised continuation then used the same worker and workspace: two approvals allowed the file read and implementation patch, but the acceptance driver incorrectly counted operator waiting time toward its deadline and stopped the worker while its Node check was pending. The stale request was not answered again; the already-written code was locally verified before independent review. After pausing the driver's active-run deadline during approval waits, the remaining three turns completed independent review, original-worker sync and original-reviewer keep, followed by the second integration.

This real run used five explicitly authorized task turns in total: failed, stopped, completed, completed, completed. An independent local audit verified nine separately reviewed single-action approvals, seven successful commands, two patches limited to the assigned file, actual reads of the updated inputs, preserved worker/reviewer native identities, final functional assertions, unchanged parent HEAD/refs/index and plugin files during execution, no persistent approval rules, removed copied credentials, and zero remaining owned processes. Native logs also rendered through the plugin's transcript reader. This is a **Node controller → real AgentManager → real Codex CLI** acceptance with recovery, not an uninterrupted four-success run, real-parent Pi tool orchestration, or a live TUI test. All drivers, raw sessions and audit artifacts remain ignored under `.test-output/`.

The local opt-in managed-workspace driver (`.test-output/phase2-real-flow.mjs`, ignored by Git) exercised one real Pi parent, two concurrent real workers, and two independent real reviewers. The parent used `create_workspace` twice and `integrate_workspace` twice, progressing through four terminal notifications without completion polling. Each worker changed only its own assigned operation, each reviewer inspected that workspace without edits, and the main sandbox passed both checks after integration while each worktree retained the other operation's original code. The external observer additionally verified review-time exclusion, duplicate-integration no-op behavior, and refusal of post-integration continuation without a baseline choice against those real instances. A separate read-only audit checked native session/model identities, actual tool calls, unchanged sandbox HEAD/refs/index, unchanged plugin files during the run, and release of all owned processes. These checks do not constitute real-terminal or crash-recovery acceptance; conflict/CRLF coverage comes from the deterministic Git tests.

The separate local opt-in `.test-output/phase2-real-sync.mjs` driver exercised authorized uncommitted-state inheritance, implementation/review/integration, a later parent-input change, and continuation of the **same** worker with `baseline: "sync"` followed by the **same** reviewer with `baseline: "keep"`. Both native session IDs were preserved across two runs, and both instances actually re-read the changed inputs before acting. The real parent used the managed tools for both integrations, received four completion notifications without polling, and verified the updated behavior. Audits checked the real read/edit calls, unchanged parent HEAD/refs/staged index, unchanged plugin code during the run, and release of all owned processes. Other negative paths remain covered by deterministic tests, not arbitrary live failure injection.

`node test/real-smoke.mjs` is an explicit opt-in real-model test; it normally makes two small calls and writes only to `.test-output/`. Local real Pi RPC acceptance also exercised a notification-driven implement → review → original-implementer continuation without `list_agents` polling. A persisted parent session was reopened after an offline child completion, with one delivered report and no duplicate on a second reopen. A real parent Pi handled a fixture child's ambiguous permission request without approving it; the human denied the request and the child still sent its final report. Temporary drivers, tasks and raw artifacts remain local.

The instance-history path has its own local driver (`.test-output/phase1-recall.mjs`, ignored by Git): one real parent dispatched two same-role workers with different tasks, exited, and a fresh process on the same session rebuilt the mapping from `list_agents` alone — resuming the correct instance by ID in its original native session while the other instance's run count stayed at one. It also caught a real defect during that check: a queued resume was briefly reported as finished, so `list_agents` now reports only runs the persisted state has acknowledged.

Automated component tests are not full terminal acceptance. A no-model Windows ConPTY smoke test also loaded the actual Pi TUI in regular and fullscreen modes: the below-editor roster, arrow-key focus, opening a running child's live conversation, tool arguments, streaming output, resizing, scrolling, closing and exiting all passed. Its child was a deterministic RPC fixture, not another model call. Real TUI permission dialogs, parent TUI exit/replay, every terminal/key protocol and theme, and execution-owner crash recovery are not comprehensively verified. TUI approval is an optional compatibility path, not a blocker for the core Pi-to-Pi collaboration test. Safety-guard false positives remain unresolved; the parent-delegated decision path has deterministic protocol tests, but its real-model authorization behavior is not yet fully verified.

## References

[Paseo](https://github.com/getpaseo/paseo) informs the lifecycle and orchestration goals. [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) informs the compact status and conversation-viewer interaction. This extension keeps its own Pi CLI process ownership and persistence model rather than importing their workflow systems.
