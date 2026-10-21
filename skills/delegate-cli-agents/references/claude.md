# Claude backend

## Runtime capabilities

Passing binary-version preflight does not prove every control is supported. Native `system/init` supplies this runtime's actual capabilities; before initialization they are unknown.

Busy input requires `msg_lifecycle_v1`: `steer` maps to non-preempting next input and `followUp` to later input, without implicit interruption. Require a correlated native receipt; an old accepted bit cannot acknowledge a new message.

Independent `interrupt` requires `interrupt_receipt_v1` and `interrupt_cancel_queued_v1`: it cancels queued input for the captured turn and waits for that turn's native terminal result. Do not probe when capabilities are missing. Interruption is neither release nor rollback. The foreground result, queued input and background work must all settle before idle; do not start another task after just the first result.

## Task forms

`AskUserQuestion` field IDs are the full question text, not short headers. Submit arrays through `answers`; the adapter handles native single-answer string mapping and multi-select encoding.

Respect explicit `multiSelect`: false permits at most one string; true permits selections plus one custom answer. Empty arrays skip optional fields only; required fields cannot be skipped. Ranges, defaults, previews and hints are not automatic answers.

Text/number cards require the native extended-question feature; the extension does not enable it. Audited limits are 8192 UTF-16 code units per string and 32768 encoded answer characters total. Cancellation denies only the question without explicitly interrupting the turn.

Preserve the input shown in the request. Do not supply host annotations/timeout fields or native permission updates. Recognized task cards are the supported exception to dedicated-dialog refusal; unknown forms remain refused.

## Permission decisions

Native signals such as a classifier marking an action non-approvable, rule-forced asks or matched ask rules are context to judge, not automatic human-intervention requirements or authorization. Decide one action within user authorization and the current `parentPolicy`.

For ordinary permissions, use the exact offered choices: Approve once, Deny once, Cancel turn, or cancellation. Never replace a task answer with Approve once or grant permanent/session permissions. A successful native stdio write has no independent approval receipt and does not prove tool execution.
