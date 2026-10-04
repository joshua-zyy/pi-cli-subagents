# Answering a child's request

Read this when a child is `waiting` on a permission or approval request. The workflow itself is in
[../SKILL.md](../SKILL.md); `subagent_query({ action: "get", id })` returns the unresolved request, and
`subagent_reply` answers one of them.

## Decide

Inspect the full request and compare it with the user's original authorization for this task. Approve
only what that authorization covers; otherwise deny or cancel, or leave it for the human with
`/agent-reply <agentId> <questionId>`. Supply a concrete `reason`: every decision is recorded locally
with the actor who made it.

An approval is always a single action. It is never a blanket permission, never a session-wide or
permanent grant (those are not offered), and never a reason to disable a safety extension.

## Boundaries the parent cannot cross

- `humanOnly` requests cannot be approved by the parent — the message says so. Ask the human, or
  deny/cancel.
- Dedicated native dialogs and unscoped requests fail closed. A refusal is not something to work around
  with a raw `cwd`, a replacement instance or a hand-edited record.
- Pi, Codex and Claude Code each offer their own choice values, including `Deny once`, `Approve once`
  and `Cancel turn`. Respond with an **exact offered value**.
- `confirmed: false` is not a decline-and-continue, and a request that already resolved or
  auto-resolved cannot be answered twice.

## Silence is not consent

A role's `mode` (`dontAsk`, `bypassPermissions`, `full-access`) removes the prompts entirely. That is a
posture its role file already chose, not evidence that anything was reviewed — do not read the absence
of a request as approval, and do not treat a completed run under such a mode as having been reviewed.
