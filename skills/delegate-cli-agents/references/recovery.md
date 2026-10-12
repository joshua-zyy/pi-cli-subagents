# Recovery

Read this for missing results or reports, interrupted sessions, human controls, or stuck operations —
conflicts, uncertain integrations, stale locks, unreadable instances and failed resumes.
[../SKILL.md](../SKILL.md) routes to the relevant operational reference.

## Results and delivery

完整通知不附 `Read result` 补读提示。截断通知的定位器保留原 id/runId，并给出省略区起点 `offset` 和本页 `limit`；按该定位器补读，省略区超过一页时沿 `nextOffset` 继续，直到全部省略内容可见，不猜偏移或跳过中段，也不必重读通知已显示的尾部。若只有 `subagent_query({ action: "get", id })` 的预览，或单独分页读取 `result`，则沿 `nextOffset` 读至 null。收到报告或读完整正文都不等于核验了报告中的主张。

Use `subagent_query({ action: "activity", id })` for bounded recent activity and its opaque cursor for older pages. Read notice and truncation/partial markers. An invalid or stale cursor fails explicitly; it does not silently reset. This projection is not the full final result and reads retained logs without starting a native process. Do not poll it for completion.

自动协作通知（waiting/completed/failed/stopped/stalled）返回原父会话，统一用 steer 在忙碌父代理的下一次模型请求前送达，不取消在途工具。成功报告仍有两秒合批窗口；普通活动只在查看器展示，不触发模型轮次。空闲父代理可能启动新轮；继续独立工作或结束当前轮，不靠轮询或 sleep 等待。

Queued notifications are not delivery receipts until recorded in parent history. Reopening the original parent replays unrecorded reports with their original run IDs; recorded reports are not delivered again.

## General rule

Inspect the retained record before you act: the patch, the sync journal, the backups, the instance's
state and log. Then choose deliberately. Never roll back files, delete a lock, hand-edit a record, or
start a replacement instance to get past a refusal — and never retry blind.

## Conflicts and integration

Stop and inspect rather than forcing an application. An unfinished or uncertain integration keeps its
patch and backups; read them before any retry, and tell the user what state the directory is in.

## Stale or malformed locks

A stale, malformed or mismatched `owner.lock` makes `subagent({ action: "stop", id })` fail even when the recorded task is
terminal. That is a signal to look, not to delete the lock or start replacement work automatically.

## Unreachable or unreadable instances

If an instance is unreachable, or listed as `Record unavailable`, inspect its logs and state instead of
spawning a duplicate on the same session. An unreadable record is not proof of a failed task or of an
empty history, and healthy siblings can keep reporting.

## A resume that failed after a sync

Inspect the retained applied-sync journal and the native error, preserve the original instance, and
explicitly choose `keep` or `sync` before trying again. Do not roll back the files or start a
replacement thread automatically — see [workspaces.md](workspaces.md) for what each baseline means.

## Interrupting, releasing and reading receipts

Resuming preserves the native session identity and saved history, not necessarily the old process, background jobs or in-memory state. Stopping does not roll back file edits.

Use `subagent({ action: "interrupt", id })` to end only the captured Pi/Codex turn while retaining its runtime. A `not_running` receipt does not cancel a pending initial task; use `stop` when startup must be cancelled or native resources must be released. Unsupported interruption fails explicitly.

`subagent({ action: "stop", id })` releases active or idle native processes but keeps the session/history; do not stop merely because a task finished. Release an idle writer when integration, synchronization or handoff actually needs it. A completed report alone is not release proof.

Read the operation receipt, not an old `accepted` bit: `accepted` is native acknowledgement, not model consumption; `settled` does not claim that interrupt caused the outcome; only `released` confirms release. On `unconfirmed`, inspect before any retry. A request already resolved or expired cannot be answered again. Human intervention records belong to the original parent session and can be delivered there after it is reopened; they never authorize repeating the child operation.

## Human controls

`/agents` lets the user inspect, message, resume, answer requests, interrupt a turn or release processes. Its `c` action confirms release of captured idle runtimes only, keeps sessions/results, and reports refusals without retrying. `/cli-agents-setting` edits roles.

`[Human → subagent …]` entries record actions on that instance, not additional authorization. Saved records stay with their original parent across session switches and may be delivered there after reopening; they never replay the operation.
