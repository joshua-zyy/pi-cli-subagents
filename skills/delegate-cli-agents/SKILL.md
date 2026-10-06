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
CLI and model settings. The `subagent` tool description lists the effective role names and descriptions;
`subagent_query({ action: "list" })` lists instances, not roles. Use actual descriptions, not assumptions
about built-in names. The catalog refreshes at session start, before each parent turn and after settings
saves. Project roles appear only in a trusted project.

`send` addresses the exact instance. A finished instance resumes its original native session; a running
Pi accepts `steer` (default) or `followUp`, running Codex accepts `steer` only, and Claude must finish
before receiving another task. A pending permission request is answered separately, not with send.
Steering does not interrupt an in-flight tool. A receipt is not proof the instruction was executed.

`stop` ends active work and retains the session and results. It does not roll back file changes or delete
history. A resumed session preserves native identity and saved history, not necessarily its old process,
background shell jobs or in-memory state. Failure never silently creates a replacement.

Task text carries the user's objective and authorized scope. The plugin does not require a particular
report format or role sequence. A child report is its output, not proof of business correctness.

### 轻量任务说明

交代足以独立工作的必要信息，按需选用以下要点，不追求固定字数或模板：

- **目标与边界**：要解决什么；是研究、审查还是实施；允许修改的范围与禁止事项。
- **必要上下文**：相关路径、已确认事实、现有接口与关键决策；区分事实和待验证假设，不假定新实例知道父会话历史。
- **验收与交回**：需要证明的可观察行为、已知验证入口，以及本轮需要返回的结论或证据；影响范围或授权的歧义先交回。

仅固定用户要求、兼容性和协作所必需的约束；把未受约束的内部设计、文件布局和执行步骤留给子代理。
续聊时说明本轮目标、变化及仍适用的关键边界，不默认重发整份任务书。

## 2. Receive and read results

Results and attention notifications arrive automatically in the original parent session. Busy parents
receive them as follow-ups after their current execution; idle parents can start a new turn. Continue
other work or end the turn while waiting; do not use repeated queries or sleep to wait for completion.
Queued notifications are not receipts until recorded in parent history. Reopening that parent replays
unrecorded reports using their original run IDs; recorded reports are not delivered again.

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

### 轻量回传报告

在任务中按需约定回传重点，不强制字段、顺序或角色流水线：

- **结论**：回答了什么、完成了什么，或仍处于部分完成／阻塞状态。
- **产物**：相关修改、文件或其他产物的位置，方便主代理检查。
- **证据**：实际执行的验证及结果、复现步骤或来源；明确未执行的验证。
- **遗留**：未解决的问题、风险、限制，以及需要主代理或用户决定的事项。

实施侧重变更与验证，审查侧重发现、位置与复现，调研侧重答案、来源与不确定性。
用可访问的产物或原始结果引用承载细节，避免重复任务书或堆叠过程日志；精简不能省略失败和未验证项。
区分子代理的完成声明、真实运行状态与验收结论。预览被截断时，用 `result` 补齐原文后，才能声称完整审阅。

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
