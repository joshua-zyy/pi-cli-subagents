# Pi backend

Read the instance's current `capabilities`; the backend name proves neither readiness nor authorization.

## Input and interruption

While running, `steer` supplies input before a subsequent model request without cancelling an in-flight tool; `followUp` waits until the current execution has no more tool calls. Sending to an idle instance starts a new run in the same native session; after release it resumes the original session without replaying the old assignment.

Independent `interrupt` clears queued input and ends the captured current turn, retaining the runtime and session rather than releasing resources. A `settled` receipt does not prove interruption caused the outcome: natural completion may race it.

## Task questions and ordinary dialogs

The child's `subagent_ask_parent` asks one task-context question at a time. For recognized `kind: "question"` with `parentPolicy.text: true`, submit an offered label or the actual custom answer once in `value`. The adapter handles the native selection/input sequence; do not select a custom-entry menu item, wait for a second question or reuse cached task answers for ordinary dialogs.

Answer ordinary `select`, `confirm`, `input` and `editor` requests from the complete request and `parentPolicy`: exact option text, a boolean confirmation or response text. Dialog shape does not prove permission provenance, nor does a button label prove a single-action effect. Judge against user authorization. Runtime-scoped requests can also occur during startup or while idle; they do not prove a new task was accepted.

Answers do not expand task authorization or grant session-wide or permanent permissions. Inspect expired or uncertain outcomes instead of submitting again.
