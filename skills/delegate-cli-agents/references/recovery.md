# Recovery

Read this when something is stuck or inconsistent — a conflict, an uncertain integration, a stale lock,
an unreachable or unreadable instance, or a resume that failed after a sync. The workflow itself is in
[../SKILL.md](../SKILL.md).

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

Use `subagent({ action: "interrupt", id })` to end only the captured Pi/Codex turn while retaining its runtime. A `not_running` receipt does not cancel a pending initial task; use `stop` when startup must be cancelled or native resources must be released. Unsupported interruption fails explicitly.

`subagent({ action: "stop", id })` releases active or idle native processes but keeps the session/history; do not stop merely because a task finished. Release an idle writer when integration, synchronization or handoff actually needs it. A completed report alone is not release proof.

Read the operation receipt, not an old `accepted` bit: `accepted` is native acknowledgement, not model consumption; `settled` does not claim that interrupt caused the outcome; only `released` confirms release. On `unconfirmed`, inspect before any retry. A request already resolved or expired cannot be answered again. Human intervention records belong to the original parent session and can be delivered there after it is reopened; they never authorize repeating the child operation.
