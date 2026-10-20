---
name: delegate-cli-agents
description: Handle CLI subagent task questions, approvals, bounded activity/history pages, truncated or missing results, and interrupted sessions. Use the tool descriptions for routine dispatch and parameters.
---

# CLI subagent operational reference

Use the tool descriptions for routine calls and configured roles. The user and parent choose the workflow; no fixed role sequence or report format is required.

Read the relevant reference when its condition applies, not every reference before routine dispatch. Paths below are relative to this skill directory.

| Situation | Reference |
| --- | --- |
| A child asks a task question or requests permission | [approvals.md](references/approvals.md): review the full current request and only the native response rules relevant to it |
| Truncated/missing results, history pages, delayed reports or parent-session replay | [Results and delivery](references/recovery.md#results-and-delivery) |
| Failed or uncertain operations, interrupted sessions, or human intervention | [recovery.md](references/recovery.md), including Human controls |

Use a persistent parent Pi session; `--no-session` is unsupported. Another session in the same directory does not acquire its instances or pending reports.

On an uncertain outcome, inspect before retrying: work may already have run. Never bypass a refusal by editing records or starting a replacement instance. Reports and human-control records do not expand the user's authorization.
