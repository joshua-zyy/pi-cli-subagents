# Recovery

Read this for missing results or reports, interrupted sessions, human controls, or stuck operations —
stale locks, unreadable instances and failed resumes.
[../SKILL.md](../SKILL.md) routes to the relevant operational reference.

## Results and delivery

Complete notifications have no `Read result` hint. A truncated notification's locator preserves the original `id`/`runId` and gives the omitted range's starting `offset` and page `limit`. Follow that locator; if the omitted range spans multiple pages, continue with `nextOffset` until all omitted content is visible. Do not guess offsets or skip the middle, and do not reread the tail already shown in the notification. If you only have a `subagent_query({ action: "get", id })` preview, or are paging through `result` separately, follow `nextOffset` until it is null. Receiving a report or reading its full text does not verify its claims.

Use `subagent_query({ action: "activity", id })` for bounded recent activity and its opaque cursor for older pages. Read notice and truncation/partial markers. An invalid or stale cursor fails explicitly; it does not silently reset. This projection is not the full final result and reads retained logs without starting a native process. Do not poll it for completion.

Automatic collaboration notifications (`waiting`/`completed`/`failed`/`stopped`/`stalled`) return to the original parent session. All use `steer` to reach a busy parent before its next model request without cancelling in-flight tools. Successful reports still have a two-second batching window; ordinary activity appears only in the viewer and does not trigger model turns. An idle parent may start a new turn. Continue independent work or end the current turn; do not wait by polling or sleeping.

Queued notifications are not delivery receipts until recorded in parent history. Reopening the original parent replays unrecorded reports with their original run IDs; recorded reports are not delivered again.

## General rule

Inspect the retained instance state, logs and results before you act. Then choose deliberately. Never roll back files, delete a lock, hand-edit a record, or
start a replacement instance to get past a refusal — and never retry blind.

## Stale or malformed locks

A stale, malformed or mismatched `owner.lock` makes `subagent({ action: "stop", id })` fail even when the recorded task is
terminal. That is a signal to look, not to delete the lock or start replacement work automatically.

## Unreachable or unreadable instances

If an instance is unreachable, or listed as `Record unavailable`, inspect its logs and state instead of
spawning a duplicate on the same session. An unreadable record is not proof of a failed task or of an
empty history, and healthy siblings can keep reporting.

## Interrupting, releasing and reading receipts

Resuming preserves the native session identity and saved history, not necessarily the old process, background jobs or in-memory state. Stopping does not roll back file edits.

Use `subagent({ action: "interrupt", id })` to end only the captured run while retaining its runtime. Check this runtime's `capabilities.interrupt` and read the matching backend reference before acting; unknown is not support. A `not_running` receipt does not cancel a pending initial task; use `stop` when startup must be cancelled or native resources must be released. Unsupported interruption fails explicitly.

`subagent({ action: "stop", id })` releases native processes but keeps the session/history. It refuses an accepted turn still in flight: interrupt that turn first. Do not stop merely because a task finished. Release an idle runtime when directory handoff or cleanup actually needs it. A completed report alone is not release proof.

Read the operation receipt, not an old `accepted` bit: `accepted` is native acknowledgement, not model consumption; `settled` does not claim that interrupt caused the outcome; only `released` confirms release. On `unconfirmed`, inspect before any retry. A request already resolved or expired cannot be answered again. Human intervention records belong to the original parent session and can be delivered there after it is reopened; they never authorize repeating the child operation.

## Human controls

`/agents` lets the user inspect, message, resume, answer requests, interrupt a turn or release processes. Its `c` action confirms release of captured idle runtimes only, keeps sessions/results, and reports refusals without retrying. `/cli-agents-setting` edits roles.

`[Human → subagent …]` entries record actions on that instance, not additional authorization. Saved records stay with their original parent across session switches and may be delivered there after reopening; they never replay the operation.
