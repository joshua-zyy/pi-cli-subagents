# Answering a child's request

Read this when a child is `waiting` on a permission request or task question. The workflow itself is in
[../SKILL.md](../SKILL.md); `subagent_query({ action: "get", id })` returns the unresolved request, and
`subagent_reply` answers one of them.

## Task questions

Pi children have a bundled `subagent_ask_parent` tool for one task-context question at a time.
For a recognized `kind: "question"` with `parentPolicy.text: true`, submit an offered label or your
actual custom answer once in `value`. The adapter handles the native selection/input sequence; do not
choose a custom-entry menu item or wait for a second question. Answer from the authorized task
context; escalate if the missing decision belongs to the user. An answer does not authorize new
actions or change permissions. This does not make unknown Pi dialogs answerable.

## Decide

Inspect the full request and compare it with the user's original authorization. Make the in-scope
one-action decision yourself using `subagent_reply`; the presence of a permission prompt is not a
reason to ask the user again. Otherwise deny or cancel, or explain the specific missing authorization
and give `/agent-reply <agentId> <questionId>` when a human decision is needed. Supply a concrete
`reason`: every decision is recorded locally with the actor who made it.

A parent-agent approval is always a single action. It is never a blanket permission, never a session-wide or
permanent grant, and never a reason to disable a safety extension.

## What the parent may submit

Each request states the responses this parent may submit. Use one of them, or refuse it
(`cancelled`, or `confirmed: false`). Claude and Codex requests carry their own one-action choices;
an audited Pi safety-guard request may be refused or allowed once, never "for this session" or
"always in this cwd". A request without a stated policy — including a record written by an earlier
version — is answered by the human: refusing from the parent still works, approving does not.

## Boundaries the parent cannot cross

- A response outside the request's stated policy cannot be approved by the parent. Prefer the offered
  one-action choice when it covers the authorized work; ask for a wider grant only if actually needed.
- Dedicated native dialogs and unscoped requests fail closed. A refusal is not something to work around
  with a raw `cwd`, a replacement instance or a hand-edited record.
- Native permission requests from Pi, Codex and Claude Code offer their own choice values, including
  `Deny once`, `Approve once` and `Cancel turn`. Respond with an **exact offered value**.
- `confirmed: false` is not a decline-and-continue, and a request that already resolved or
  auto-resolved cannot be answered twice.

## Silence is not consent

A role's `mode` (`dontAsk`, `bypassPermissions`, `full-access`) removes the prompts entirely. That is a
posture its role file already chose, not evidence that anything was reviewed — do not read the absence
of a request as approval, and do not treat a completed run under such a mode as having been reviewed.
