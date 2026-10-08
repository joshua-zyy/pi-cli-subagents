---
name: delegate-cli-agents
description: Handle CLI subagent approvals, truncated or missing results, managed-worktree baselines, and interrupted sessions. Use the tool descriptions for routine dispatch and parameters.
---

# CLI subagent operational reference

The tools describe routine calls and list the configured roles. This reference covers delivery,
permissions, workspace baselines and recovery. The user and parent agent choose the workflow;
no fixed role sequence or report format is required.

## Notifications and results

Reports return automatically to the original parent session. Waiting requests steer a busy parent
before its next model request; other batches follow up after its current execution. Idle parents can
start a new turn. Continue other work or end the turn rather than polling or sleeping for completion.

A notification or `subagent_query({ action: "get", id })` may contain only a preview. If it is truncated,
read the missing text with `result` before claiming a complete review. Receiving a completed report is
not the same as verifying its claims.

Queued notifications are not receipts until recorded in parent history. Reopening the original parent
replays unrecorded reports with their original run IDs; recorded reports are not delivered again.

## Pending requests

Handle task-scoped requests yourself; do not pass routine approvals to the human. Inspect the current
request with `subagent_query({ action: "get", id })` when its content or policy is missing, truncated or
stale. Use its type and exact permitted options, not guesses. Send the answer through `subagent_reply`,
not `subagent` send. See [references/approvals.md](references/approvals.md) for
single-action authorization and human-only requests.

## Managed worktrees

Read [references/workspaces.md](references/workspaces.md) before creating, syncing or integrating a
workspace. It covers committed versus uncommitted baselines, workspace ownership, and what the child
must re-read after files change underneath its saved conversation. Isolation does not expand permissions.

## Recovery and persistence

Stopping does not roll back edits or delete history. Resuming preserves native identity and saved
history, not necessarily the old process, background jobs or in-memory state. Steering does not interrupt
an in-flight tool, and a delivery receipt does not prove the instruction was executed.

For failed or uncertain operations, inspect the retained state before retrying: work may already have
run. Follow [references/recovery.md](references/recovery.md) for conflicts, stale locks, unreadable
records and failed resumes. Do not bypass a refusal by editing records or starting a replacement instance.

The parent must use a persistent Pi session, not `--no-session`. Another session in the same directory
does not acquire its instances or pending reports.

## Human controls

`/agents` lets the user inspect, message, resume, answer requests or stop instances;
`/cli-agents-setting` edits roles. `[Human → subagent …]` entries record actions on that instance only,
not additional authorization.
