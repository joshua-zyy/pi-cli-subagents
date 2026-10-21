---
name: delegate-cli-agents
description: Read backend-specific rules before sending, interrupting or replying to a CLI subagent; handle approvals, paged results and uncertain recovery.
---

# CLI subagent operational reference

The user and parent choose roles and collaboration workflows; no fixed role sequence or report format is required.

## Load knowledge for the instance before acting

Read the instance's `cli`, `runtimeId` and `capabilities` from tool responses. If identity or capability evidence is missing from context, use `subagent_query get`; queries do not start processes. Do not infer an existing instance's backend from its role name or current role configuration.

Before the first send, interrupt or reply for a backend, read `references/<cli>.md` relative to this skill directory, substituting the instance's returned `cli`. Read only that backend, not every backend manual. Reuse guidance already read while it remains applicable; do not reread it for every operation.

`capabilities.busySendModes` lists supported input modes while running; `interrupt` describes independent interruption support. `null` means unknown, while an empty array or `false` means unsupported. Do not probe by making a control call. Capabilities belong to the current runtime and must be reconfirmed for a new runtime; they establish neither current readiness nor authorization. Sending to an idle instance starts a new run, not busy input.

Reply according to the current request's `parentPolicy`, `method` and `fields`, not instance capabilities or an old question. A supported response is not permission to perform the action.

## Load shared rules for the situation

| Situation | Reference |
| --- | --- |
| A child asks a task question or requests permission | [Approvals and replies](references/approvals.md), plus the current backend reference |
| Truncated results, delayed reports or parent-session replay | [Results and delivery](references/recovery.md#results-and-delivery) |
| Interruption, release, failed resume, uncertain state or human intervention | [Recovery](references/recovery.md) |

Use a persistent parent session; `--no-session` is unsupported. Another session in the same directory does not acquire its instances or reports.

On uncertainty, inspect retained state, logs and results before retrying. Never retry blind, edit records or start a replacement to bypass a refusal. Reports and human-control records do not expand the original authorization.
