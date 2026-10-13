# Answering a child's request

Read this when a child has a pending permission request or task question, including non-blocking forms while `running`. The workflow itself is in
[../SKILL.md](../SKILL.md); `subagent_query({ action: "get", id })` returns the unresolved request, and
`subagent_reply` answers one of them.

## Task questions

Pi children have a bundled `subagent_ask_parent` tool for one task-context question at a time.
For a recognized `kind: "question"` with `parentPolicy.text: true`, submit an offered label or your
actual custom answer once in `value`. The adapter handles the native selection/input sequence; do not
choose a custom-entry menu item or wait for a second question. Answer from the authorized task
context; escalate if the missing decision belongs to the user. An answer does not authorize new
actions or change permissions. Other Pi dialogs are separate generic requests; do not reuse a cached task answer for them.

If Codex reports `request_user_input` unavailable in Default mode, check the configured role and actual
CLI version/configuration before trying again. The Codex-only role field `defaultModeQuestions: true`
opts into the experimental native Default-mode feature (checked with 0.159.2); `false` disables it, and
omission/UI `inherit` leaves native configuration in charge. It does not switch to Plan, grant permissions,
or override a disabled `tools.experimental_request_user_input.enabled`. Configure a new instance only
within the user’s authorization: editing the role does not change an existing instance’s saved settings.
Do not widen permission `mode`, edit global config, or silently launch a replacement as a workaround.

For a Codex or Claude `form` with `parentPolicy.answers: true`, read the full `fields` with `subagent_query get`.
Submit one `answers` object mapping every exact field ID to a string array, respecting offered labels
and `allowOther`. Use `[]` to skip an optional field; `required: true` needs one non-blank string.
Use `cancelled: true` to dismiss the whole form; never
guess a first choice or replace an ID with its display header. Do not mix `answers` with `value` or
`confirmed`. Non-blocking questions permit continued work, but answers still expire with their
original request/turn. Never retry an uncertain delivery or send the answer as a new prompt.

Codex may ask through an asynchronous `agentMessage` before calling `requestUserInput`. A recognized
async question reaches the parent immediately as a non-blocking form with indexed field IDs and
`required: true`. Answer it through `subagent_reply`, not by sending a separate task: the adapter
formats the context and steers the captured active turn once. Cancellation is local dismissal;
turn end invalidates the request rather than starting an idle follow-up. It is not an RPC approval.

Codex treats answers as trusted user input: provide only the user’s already-authorized context, not
new authorization. A recognized `mcp_tool_call_approval_<callId>` tied to a live MCP action is a
permission, not a task question: inspect the server/tool/arguments, then use the offered `value`
("Allow" or "Cancel") or cancellation with a reason. Never submit `answers` or a persistent grant.
The separate MCP elicitation entry uses `confirm` only when explicit approval metadata, a message-only
form and one live same-server call are unambiguously bound. Submit `confirmed: true` to accept, false
to decline, or `cancelled: true` to cancel. Do not submit form content or persistence metadata.
Uncorrelated/ambiguous requests, data or URL forms and unknown approval kinds remain refused; do not
work around the refusal. The reserved IDs belong to the host. Sensitive fields
are marked, not masked or guaranteed absent from native logs; do not invent or expose secrets.

Claude `AskUserQuestion` field IDs are the full question text, not short headers. Respect explicit
`multiSelect`: false permits at most one string, true permits selections plus one custom answer.
Send arrays through `answers`; the adapter maps single answers to strings and leaves multi-select
encoding to Claude. `[]` skips; no range/default hint is an automatic answer. Native previews and
hints are context to read, not new authorization. Text/number cards require the native extended-question
feature; this extension does not enable it. Answers are bounded locally using the audited strict-card
limits (8192 UTF-16 code units per string, 32768 encoded answer characters). Cancellation denies the
question without explicitly interrupting the turn. Do not replace an answer with `Approve once`,
change shown input, supply host annotations/timeout fields, or write native permission updates.
Native policy signals (classifier not approvable, rule-forced asks, matched ask rules) appear in the
request message as context; they do not require human intervention. The recognized question card is
the only supported exception to the generic dedicated-dialog refusal. Unknown forms remain refused.

## Decide

Inspect the full request and compare it with the user's original authorization. Make the in-scope
one-action decision yourself using `subagent_reply`; the presence of a permission prompt is not a
reason to ask the user again. Escalate if context, effects or authorization are unclear, or the user
explicitly requires their confirmation. Otherwise deny or cancel, or explain the specific missing authorization
and direct the human to `/agents`, select the child, `i` details and `r` reply. The panel also answers non-blocking requests while the child is running. Supply a concrete
`reason`: every decision is recorded locally with the actor who made it.

Approve only the authorized action. Do not grant blanket, session-wide or permanent permissions, or
disable a safety extension. A generic Pi confirmation or option does not by itself prove a single-action effect.

## What the parent may submit

Treat `parentPolicy` as the supported response shape, not an authorization verdict. Pi `select`
requires an exact native option in `value`; `confirm` uses `confirmed`; `input`/`editor` use text in
`value`. Cancellation is available for all four. Read the complete request and decide within scope;
there is no special safety-guard button whitelist and no automatic approval. Claude and Codex retain
their native one-action mappings; Claude's native policy signals are context for your decision, not a block. A request without a stated policy,
including a legacy record, remains refusal-only for the parent; the human can answer in `/agents`.

## Boundaries the parent cannot cross

- A response outside the request's stated policy cannot be approved by the parent. Prefer the offered
  one-action choice when it covers the authorized work; missing authorization must be resolved by the user.
- Unrecognized dedicated native dialogs and unscoped requests are refused per request with a native deny or
  cancel while the turn continues; the child sees the refusal and reports. A refusal is not something to work around
  with a raw `cwd`, a replacement instance or a hand-edited record.
- Native permission requests from Pi, Codex and Claude Code offer their own choice values, including
  `Deny once`, `Approve once` and `Cancel turn`. Respond with an **exact offered value**.
- `confirmed: false` is not a decline-and-continue, and a request that already resolved or
  auto-resolved cannot be answered twice.

## Silence is not consent

A role's `mode` (`dontAsk`, `bypassPermissions`, `full-access`) removes the prompts entirely. That is a
posture its role file already chose, not evidence that anything was reviewed — do not read the absence
of a request as approval, and do not treat a completed run under such a mode as having been reviewed.
