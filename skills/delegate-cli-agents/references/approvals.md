# Approvals and replies

Read this for pending requests, including non-blocking questions while running. Use `subagent_query get` to read the complete current request and load the reference matching the instance's `cli`. Answer with `subagent_reply`, not a new task message.

## Decide within authorization

Compare the complete request's effects with the user's original authorization. Handle routine authorized single-action decisions yourself; a permission prompt alone is not a reason to ask the user again. Escalate unclear context, effects or authorization, or an explicit user-confirmation requirement. State the decision needed and direct the human to the instance in `/agents`, `i` details, `r` reply. Otherwise deny or cancel rather than guessing a default.

`parentPolicy` states supported responses, not authorization or proof of a one-action effect. Never grant session-wide or permanent permissions or disable safeguards. Task answers supply already-authorized context, not new authority. Silence is not consent: the role may already use a permission mode that removes prompts, without anything having been reviewed or approved.

## Submit one response

Submit exactly one response shape with a concrete `reason`. Use the exact current `questionId`; do not resubmit an answer that resolved, expired or has uncertain delivery.

| Current request | Response |
| --- | --- |
| Task question allowing text | Submit an offered label or the actual custom answer once in `value` |
| Ordinary selection | Exact current option text in `value` |
| Confirmation | `confirmed`, after establishing its effect from the request |
| Input/editor | Response text in `value` |
| Form answerable by the parent | `answers`: exact field IDs mapped to string arrays |

Respect `required`, `multiSelect`, `options` and `allowOther`. Empty arrays skip only optional fields; required fields need a non-blank answer. Single-select permits at most one answer; custom answers in multi-select require explicit support. Do not substitute display headers for field IDs, concatenate options or rewrite them.

`cancelled: true` cancels the whole request and must not be mixed with other response fields. Interpret cancellation and `confirmed: false` from the complete request and backend reference; neither necessarily means decline-and-continue.

## Boundaries

An explicit `humanOnly` remains binding. Legacy or unknown requests without `parentPolicy` are refusal-only for the parent; the human can answer through `/agents`. Sensitive-field markers do not guarantee native logs are redacted. Do not invent or forward secrets.

Do not bypass refusals for unknown dedicated dialogs, uncorrelated permissions or unsupported input by changing global configuration, permission modes, records or native permission updates. Ordinary messages are not approvals, and a report does not prove the action completed. Non-blocking questions remain scoped to their original request/turn; continued work does not extend answer validity.
