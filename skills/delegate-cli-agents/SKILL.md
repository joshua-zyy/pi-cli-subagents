---
name: delegate-cli-agents
description: Delegate local coding, exploration, implementation, or independent review to reusable Pi, Codex or Claude Code CLI subagents with single-action approvals. Use when parallel work or an implement–review–fix loop benefits from another real CLI session and the spawn_agent, send_input, list_agents, and close_agent tools are available.
---

# Delegate CLI agents

Delegate **independent, verifiable** work, not volume. One agent is the default; add a second only when
two workstreams can be verified separately and do not write the same files. If the task fits your own
context, do it yourself — a child's report is a summary, not a substitute for reading the code.

## 1. Brief before you spawn

`spawn_agent({ role, task, cwd | workspace })` — never both. Use `list_agents` once to see configured
roles and existing instances, and never poll it for completion. Codex roles need an explicit available
model.

State the goal, the authorized paths, what is out of scope, and the evidence you will accept as done.
Ask for the child's final message to end with this block:

    VERDICT: <one line>
    EVIDENCE: <one line per item, each with a locator>
    UNVERIFIED: <what you did not check>

What the work is decides the evidence it owes — never the role's name. `list_agents` returns the roles
this project actually offers, with their descriptions; route by that description. The built-in names
below always resolve, but a project or user role file can override what any of them does, and custom
roles can be added — so read the description before you rely on a name. If no configured role covers the
work, ask the user which role to use, or add one with `/cli-agents-setting`; do not stretch an unrelated
role to fit.

| work | built-in role | VERDICT | EVIDENCE |
|---|---|---|---|
| investigate without changing files | `explore` | the finding | file/symbol or source per claim |
| implement and verify a change | `worker` | what changed | the exact command and what it printed |
| independently assess a change | `reviewer` | `PASS` or `BLOCK` | per defect: file:line and a trigger |
| judge material you hand over | `oracle` | the answer | the material judged, plus confidence |

A report without evidence is not a finished task: do not build on it and do not integrate it. Ask the
same instance for the missing evidence, or carry the work forward as unverified. Say which revision the
work is against; a finding without a revision cannot be acted on later.

A managed worktree is optional — use a shared `cwd` unless the work needs isolation. Before creating or
integrating one, read [references/workspaces.md](references/workspaces.md).

## 2. Wait for reports

Spawning is asynchronous: continue independent work or end the turn — the report wakes you. Completed,
failed, waiting, unreachable and stalled children all arrive on their own; never poll `list_agents`
for progress. Use `list_agents()` for metadata and history, or `list_agents({ id })` for current details
and a bounded result preview. Neither the preview nor the notification guarantees complete evidence.

When a decision needs omitted material, follow the notification’s `list_agents({ id, runId })` link.
It returns a page of that run’s original final result, with `status`, `error`, `text`, `totalLength` and
`nextOffset`. Keep both IDs fixed; pass `offset: nextOffset` until it is `null` to read the entire result
(default/max `limit: 6000` UTF-16 code units). A later run never replaces this result. A missing result
is an error, not permission to substitute the latest run. Never read empty text or a completed CLI
turn as proof the task succeeded. Keep `src/example.ts:42`-style locators, not paraphrases.

## 3. Reuse the instance that did the related work

A role is a template; each instance is a separate colleague with its own session. `list_agents` returns
each instance's `history` (latest five assignments with their outcome, oldest first), so recover who did
what from there instead of trusting recall after your context is compacted. Preserve older result links
you still need in your task notes. Send follow-up work to the
instance that already has the context; start a new one for unrelated work; never let an instance review
its own work. A running child takes `send_input` steering on Pi and Codex (running Codex `followUp`
is not supported); Claude refuses both while running — wait for it. Steering does not interrupt an
in-flight tool. Session memory is not a current view of the files: say what has changed and what to
re-read.

## 4. Close the loop

implement → review → fix → integrate, in that order. Give the reviewing instance the **same workspace
or cwd** as the one that made the change, and start it only after that instance stops. Send fixes back
to the **same instance's id**, and only after the review finishes. Then `integrate_workspace`, and verify
the main directory yourself.
`BLOCK` means stop and inspect, not force. Do not commit, push or delete worktrees unless asked, and
never bypass a refusal with a raw `cwd`, a replacement instance or a hand-edited record. When something
is stuck or inconsistent — a conflict, an unfinished integration, a stale lock, an unreachable or
unreadable instance, a resume that failed after a sync — read
[references/recovery.md](references/recovery.md) before touching anything.

## 5. Answering a child's request

A `waiting` child is blocked, not finished. Approve only what the user's own task authorization covers,
never as a blanket permission; a `humanOnly` request cannot be approved by the parent; a fail-closed
refusal is not bypassed. Read [references/approvals.md](references/approvals.md) before answering, or
hand the decision to the human with `/agent-reply <agentId> <questionId>`.

## 6. The human has their own surface

A status area above the editor, and `/agents` to inspect results, open a live conversation, message,
resume, answer a pending request, or stop an instance. Their direct actions appear in this session as
`[Human → subagent …]` entries without interrupting you: re-check your plan for that instance before
integrating its work, and treat it as authorization for that instance only.

`close_agent` stops active work but keeps the session — never use it merely because a task finished. The
parent session must be persistent: a running child survives the parent's exit, and its report is
delivered on return to the **original** parent session.
