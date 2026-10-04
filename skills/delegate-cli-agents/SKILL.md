---
name: delegate-cli-agents
description: Use the subagent, subagent_query, subagent_reply, and subagent_workspace tools to start and manage persistent Pi, Codex or Claude Code CLI sessions, read results, handle requests, and use isolated worktrees.
---

# CLI subagent tools

These tools provide CLI session management, not a prescribed workflow. The user's instructions decide
whether to delegate, which configured role to use, whether to reuse an instance, and whether to review
or integrate its work. Built-in roles are defaults, not fixed jobs or model rankings.

## 1. Start, send, stop

Use `subagent` with an explicit action:

| Action | Required fields | Optional fields |
|---|---|---|
| `start` | `role`, `task` | `cwd` or `workspace` (never both) |
| `send` | `id`, `message` | `mode`, `baseline`, `includeUncommitted` |
| `stop` | `id` | none |

`start` creates a new instance; omitted `cwd` uses the parent directory. Role configuration supplies the
CLI and model settings. `subagent_query({ action: "list" })` includes configured role descriptions and
existing instances. Use the actual descriptions, not assumptions about built-in names.

`send` addresses the exact instance. A finished instance resumes its original native session; a running
Pi accepts `steer` (default) or `followUp`, running Codex accepts `steer` only, and Claude must finish
before receiving another task. A pending permission request is answered separately, not with send.
Steering does not interrupt an in-flight tool. A receipt is not proof the instruction was executed.

`stop` ends active work and retains the session and results. It does not roll back file changes or delete
history. A resumed session preserves native identity and saved history, not necessarily its old process,
background shell jobs or in-memory state. Failure never silently creates a replacement.

Task text carries the user's objective and authorized scope. The plugin does not require a particular
report format or role sequence. A child report is its output, not proof of business correctness.

## 2. Receive and read results

Results and attention notifications arrive automatically in the original parent session. Continue other
work or end the turn while waiting; do not use repeated queries or sleep to wait for completion.

| Query action | Required fields | Result |
|---|---|---|
| `list` | none | Instance metadata and workspace inventory; no report bodies |
| `get` | `id` | Current state, recent history, pending requests and bounded result preview |
| `result` | `id`, `runId` | A page of that exact run's original final report |

For long results, keep both IDs fixed and follow `nextOffset` as `offset` until null. `limit` defaults to
6000 UTF-16 code units and cannot exceed 6000. The response includes status, error, text and totalLength.
A missing result is an error, not permission to use another run. Reading never resumes an instance.

Failure replies preserve the instance/run and error. Inspect before retrying: a timeout may occur after
work ran, and an unconfirmed receipt does not mean there were no side effects. An unreadable record or
unreachable instance does not prove an empty history or an ended execution.

## 3. Answer a current request

`subagent_reply({ id, questionId, reason, confirmed | value | cancelled })` answers one unresolved
request. Supply exactly one answer matching its type and the user's existing authorization. The tool
records a parent decision; it cannot impersonate a human or grant persistent permissions.

A `humanOnly` approval must use the human UI. The parent may deny/cancel where allowed. See
[references/approvals.md](references/approvals.md) for request types and permission boundaries.

## 4. Managed worktrees

`subagent_workspace({ action: "create" })` creates an isolated worktree; then use its ID in a start call.
Different workspaces can run concurrently. One workspace permits one active instance at a time and may
be reused by another instance after release. Isolation is explicit, not automatically chosen by the plugin.

`subagent_workspace({ action: "integrate", workspace })` applies its pending changes to the parent.
It does not commit, push or remove the worktree. The user's workflow decides when integration is appropriate.
Read [references/workspaces.md](references/workspaces.md) before creating, syncing or integrating one.

For conflicts, stale locks, uncertain operations or failed recovery, read
[references/recovery.md](references/recovery.md). Do not bypass a refusal by editing records, using raw
cwd, creating a replacement instance, resetting files or disabling safety checks.

## 5. Human controls and persistence

`/agents` lets the user view conversations, message, resume, answer requests or stop instances.
Their actions appear in the parent context as `[Human → subagent …]` entries. These refer to that
instance only and do not widen authorization. `/cli-agents-setting` edits role configuration.

The parent must use a persistent Pi session, not `--no-session`. Pending reports return to the original
parent session; another session in the same directory does not acquire ownership.

## Old tool references

Historical messages remain unchanged. Translate old calls using their original IDs:

| Old name | Current call |
|---|---|
| `spawn_agent` | `subagent({ action: "start", ... })` |
| `send_input` | `subagent({ action: "send", ... })` |
| `close_agent` | `subagent({ action: "stop", id })` |
| `list_agents()` / `{id}` / `{id, runId}` | `subagent_query` with `list` / `get` / `result` |
| `respond_to_permission` | `subagent_reply` |
| `create_workspace` | `subagent_workspace({ action: "create", ... })` |
| `integrate_workspace` | `subagent_workspace({ action: "integrate", workspace })` |
