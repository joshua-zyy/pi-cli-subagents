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

A stale, malformed or mismatched `owner.lock` makes `close_agent` fail even when the recorded task is
terminal. That is a signal to look, not to delete the lock or start replacement work automatically.

## Unreachable or unreadable instances

If an instance is unreachable, or listed as `Record unavailable`, inspect its logs and state instead of
spawning a duplicate on the same session. An unreadable record is not proof of a failed task or of an
empty history, and healthy siblings can keep reporting.

## A resume that failed after a sync

Inspect the retained applied-sync journal and the native error, preserve the original instance, and
explicitly choose `keep` or `sync` before trying again. Do not roll back the files or start a
replacement thread automatically — see [workspaces.md](workspaces.md) for what each baseline means.

## Stopping versus finishing

`close_agent` stops active work but keeps the native session for later continuation; never use it merely
because a task finished. A malformed request from a child that has already ended cannot be answered
again — inspect the current state instead.
