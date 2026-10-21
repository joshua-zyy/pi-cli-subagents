# Codex backend

## Input and interruption

While running, only `steer` is supported, not `followUp`. If a later task is needed, wait for the automatic completion report, then send to the idle instance. Do not discover restrictions through failed calls. Idle continuation and resume after release retain the original native session.

Independent interruption captures the current turn and waits for its native terminal result while retaining the runtime; it does not close the process. Follow instance capabilities and receipts, and never treat acceptance as task success.

## Task questions

If native `request_user_input` is unavailable in Default mode, check the role and actual CLI version/configuration. The role field `defaultModeQuestions: true` opts into the experimental feature checked against 0.159.2; `false` disables it, and omission/UI inherit leaves native configuration in charge. It does not switch to Plan, grant permissions or override a disabled `tools.experimental_request_user_input.enabled`.

Configure new instances only within user authorization; role edits do not change an existing instance's saved settings. Do not widen permissions, edit global configuration or silently launch a replacement to bypass a restriction.

For a `form` with `parentPolicy.answers: true`, read the complete `fields` and map exact field IDs to answer arrays, respecting required fields and choices. Do not replace IDs with display headers or mix `answers` with `value`/`confirmed`.

An asynchronous `agentMessage` may also produce a non-blocking question with indexed, required field IDs. Still answer through `subagent_reply`: the adapter sends correlated answers only to the captured active turn, never an idle follow-up. Cancellation dismisses the question locally; turn end invalidates it. This is not an RPC approval. Answers are treated as trusted user input, so provide only already-authorized context.

## Native permissions and MCP requests

A `mcp_tool_call_approval_<callId>` tied to a live MCP action is a permission request, not a task form. Inspect server/tool/arguments, then submit the exact offered `value` Allow/Cancel or cancellation with a reason. Do not submit `answers` or a persistent grant.

Separate MCP elicitation uses confirmation only when explicit approval metadata, a message-only form and one live same-server call are unambiguously bound. Use `confirmed: true` to accept, false to decline, or `cancelled: true` to cancel. Do not submit form content or persistence metadata. Uncorrelated or ambiguous requests, data/URL forms and unknown permission kinds remain refused. Reserved IDs belong to the host; do not work around refusals.

For other permissions, use the current `parentPolicy` response shape, not a previous request's shape. Sensitive fields may remain in native logs; do not invent or expose secrets. Never retry uncertain delivery or resend the answer as an ordinary message.
