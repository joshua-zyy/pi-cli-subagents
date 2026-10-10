# CLI Subagent Four-Tool Interface Design

Status: the four tools, role catalog and follow-up notifications were implemented in separate increments, with `b406426` as the code baseline. Local verification passed; the real-model and real-CLI collaboration experience has not yet been accepted.

The current scope covers only CLI subagent dispatch and management by the parent Pi agent. `@role` and a new direct user dispatch entry point are deferred; the existing user management UI remains. This document refines the product goals and does not authorize further code changes, real dispatch or model calls.

## 1. Design conclusion

Use four tools with separate responsibilities, exposing the role catalog directly in the dispatch tool's description. Preserve native sessions, historical results and workspace identity; do not reduce the tool count by removing capabilities.

| New tool | Operations | Existing capability source |
|---|---|---|
| `subagent` | `start` / `send` / `interrupt` / `stop` | `spawn_agent` / `send_input` / `close_agent` |
| `subagent_query` | `list` / `get` / `result` / `activity` | Existing inventory/result reads plus bounded projected history |
| `subagent_reply` | Answer one specific request; no action required | `respond_to_permission` |
| `subagent_workspace` | `create` / `integrate` | `create_workspace` / `integrate_workspace` |

Do not add automatic task assignment, automatic instance reuse, model overrides, mandatory reviews, automatic retries or an automatic worktree policy. Workspace tools remain available normally; the user and parent agent decide whether to use them, without an additional opt-in switch.

The following is a logical parameter contract, not the final TypeBox/JSON Schema code. Each action has its own required and allowed fields; inapplicable fields must be rejected rather than silently ignored. The implementation uses a root-object schema with additional action-level field checks before execution. Local interface tests have passed; neither documentation examples nor local success establish compatibility with every model endpoint.

## 2. `subagent`: instance lifecycle

### 2.1 Parameters

| action | Required | Optional | Semantics |
|---|---|---|---|
| `start` | `role`, `task` | `cwd` or `workspace` | Create an instance and execute its first task; cwd and workspace are mutually exclusive |
| `send` | `id`, `message` | `mode`, `baseline`, `includeUncommitted` | Deliver instructions while running, or begin a new run in the same native session after completion |
| `interrupt` | `id` | None | End only the captured current turn, retaining a usable runtime; unsupported backends reject |
| `stop` | `id` | None | Release active/idle native resources while retaining the native session and history; do not delete files or roll back changes |

`start` defaults to the current Pi working directory; when workspace is specified, resolve its actual path from the record. The role must exist in the current effective configuration. Resolve CLI, provider and model from role configuration; do not expose per-run model-routing parameters. task/message must be non-empty.

`send.mode` remains `steer | followUp`, defaulting to steer. It controls how the child receives instructions, not how result notifications are delivered to the parent agent.

| Target state / CLI | `send` behavior |
|---|---|
| Running Pi | Deliver using the selected steer/followUp mode; receipt does not imply execution |
| Running Codex | Use the supported steer path; explicitly reject followUp |
| Running Claude | Running delivery is currently unsupported and explicitly rejected; wait for the run to end before continuing |
| Unresolved blocking interaction request | Direct the caller to `subagent_reply` or the user interaction entry point; ordinary messages are not approvals |
| Idle Pi/Codex runtime | Begin a new run in the same worker/CLI; retain the native session and runtime identity |
| Closed, with a recoverable original session | Resume the original session in a new runtime; never replay a prior assignment |
| Missing session, unclear occupation or uncertain state | Reject with diagnostic guidance; do not silently create a replacement |

These CLI capabilities describe the current implementation, not a promise that every upstream version will behave identically forever.

New Pi/Codex workers remain resident after a run ends: `phase: idle` describes the runtime, while `lastStatus` and the immutable per-run report describe the outcome. `stop` releases both idle and active runtimes; it never rewrites an already finished report. Claude remains non-resident until its native multi-turn/background boundary is verified. Residency preserves the opportunity for background work, not permanent process survival or authorization for more model work. A confirmed native exit becomes closed with a distinct runtime notice; missing worker/ownership proof becomes unreachable and prevents replacement work.

New control endpoints use protocol v2, `runtimeId` and an expected current `runId`; stale or legacy control requests cannot operate a v2 worker. Existing workers are not hot-replaced. Only after confirmed native release is a terminal snapshot persisted with `runtimeClosed: true`, retaining old terminal enums for downgrade readers; the current manager exposes this as closed. Interrupt is public with captured-run confirmation and no replay after uncertainty; it does not substitute for release. Continuous runtime logs reuse the first run's events file, with instance-contained references and deduplicated history sources. Queries do not start a CLI.

Ordinary Pi dialogs can originate during startup or while idle, and their wire format does not establish task ownership. Known blocking startup dialogs are answered before the first prompt without blocking the reply control queue; dialogs observed later are still forwarded and survive normal task completion. Explicit interruption invalidates dialogs observed in that turn, while earlier runtime dialogs remain pending; release cancels all. Logical `subagent_ask_parent` IDs include the host run ID, so a repeated native tool-call ID cannot make an old answer apply to a later run. These are lifetime/correlation rules, not authorization evidence.

`baseline: keep | sync` and `includeUncommitted: { reason }` apply only to managed workspaces. Continuing an instance after integration or a baseline change requires an explicit baseline choice. Sync cannot run on an active instance or overwrite unintegrated changes. Under the workspace lease, it closes only the target idle writer, confirms release, preflights the original session, then synchronizes and resumes. Invalid confirmation metadata is rejected before closing; later preflight/content refusals can leave the runtime closed, with no new run and no automatic replay. Integrate refuses any remaining writer, including idle, until explicitly stopped. The reason records the caller's explanation; it is not proof that the extension has established user authorization.

### 2.2 Results and errors

Keep existing instance information: `id`, `runId`, `role`, `cli`, `phase`, `cwd`, known native session identity, pending requests, and workspace / workspaceBaseline where applicable. Include errors and locations as needed, not the entire native configuration or credentials.

Do not introduce an ambiguous `success: true` that collapses all states:

| Result | What it must express |
|---|---|
| Accepted | What was accepted and the current state; no guarantee of task success |
| Explicit rejection | The reason; do not describe this operation as dispatched |
| Uncertain startup/delivery confirmation | Known instance and run, record locations and uncertain facts; no automatic retry |
| Completed or failed | Report the actual task state; do not hide immediate failure behind a successful-dispatch label |
| Confirmed stop | The old execution has stopped/released resources; its work has not necessarily been undone |
| Unconfirmed stop | Preserve uncertainty and diagnostic guidance; do not announce that takeover is safe |

The existing `AgentState.accepted` describes receipt of the run's initial task, not an independent receipt for every send. An existing true value cannot prove delivery of a new message, and false cannot prove that no prompt was written. Each operation returns a transient `receipt` with `operation`, `status`, affected `runId` and known `runtimeId`; it is not persisted into state/results or synthesized by queries. `accepted` requires the corresponding native acknowledgement; otherwise startup/legacy uncertainty is `unconfirmed`. Current adapters do not emit queue/injection claims merely from a delivery mode. `settled` confirms that the captured turn ended, including a natural-completion race; `not_running` confirms no captured active turn and does not cancel pending startup; `released` requires matching-runtime release proof. Errors retain known identity and no automatic retry. This follows the distinction between acceptance and applied notification in [Lody's pinned acknowledged-steer design](https://github.com/LodyAI/Lody/blob/6dc434952ab2e942291cc8392316bf760afbdaf0/apps/cli/src/agent/acknowledged-steer.ts), without importing ACP/Core or inventing an applied signal.

### 2.3 Examples

```json
{"action":"start","role":"implementer","task":"Complete the specified change","workspace":"<workspace-id>"}
```

```json
{"action":"send","id":"<agent-id>","message":"Continue working on this issue","baseline":"keep"}
```

```json
{"action":"stop","id":"<agent-id>"}
```

The example role name does not require the extension to provide that built-in role; actual roles come from user configuration.

## 3. `subagent_query`: read-only queries

| action | Required | Optional | Returns |
|---|---|---|---|
| `list` | None | None | Compact metadata for this parent's instances and the managed-workspace inventory, without report bodies |
| `get` | `id` | None | State, recent task history, pending requests and a bounded result preview for the specified instance |
| `result` | `id`, `runId` | `offset`, `limit` | Pages of the specified run's original final report |
| `activity` | `id` | `cursor`, `limit`, `maxBytes` | Recent projected entries, then older pages via the returned cursor |

Keep the workspace inventory in `list` so reusable workspaces and their occupation can be discovered without a fifth listing tool. `get` may include necessary information about the instance's associated workspace; do not add cross-parent-session scanning.

The result action retains the current pagination contract: offset defaults to 0; limit defaults to and cannot exceed 6000 UTF-16 code units. Return `agentId`, `runId`, `status`, `time`, `error`, `offset`, `totalLength`, `nextOffset` and `text`. Keep id/runId fixed and follow nextOffset until null.

Reject missing, corrupt, cross-instance or cross-parent-session results. A missing original report cannot be replaced with the current latest result. Reading must not start, wake or stop an instance, or approve an operation. Neither a result preview nor terminal state proves acceptance of the business outcome.

### Activity paging

Activity uses the same pure transcript reader as the viewer, not a raw transport dump. It returns `{ id, entries, hasMore, cursor?, notice? }`; entries are chronological within each page and only recognized messages, tool activity and notices are projected. `limit` defaults to 20 and must be 1–100. `maxBytes` defaults to 16384 and must be 4096–65536; the limit covers the entire JSON response in UTF-8, including cursor and metadata. Invalid limits are errors, not silently clamped values.

The first call reads a bounded recent tail. Pass the returned opaque cursor unchanged to read older entries; no cursor means a new recent-tail query. Versioned cursors bind the instance/backend and a real log byte position with a bounded file-identity/anchor witness. Foreign, malformed or detected stale cursors fail rather than silently jumping to the tail. Normal append-only growth remains valid. This is not a whole-history integrity check: arbitrary far-away in-place edits outside the witness are not guaranteed detectable. No cursor store, CLI startup/resume, native-history rewrite or background scan is introduced.

Byte trimming keeps dropped older entries reachable through the next cursor, following [Lody's pinned history-page contract](https://github.com/LodyAI/Lody/blob/6dc434952ab2e942291cc8392316bf760afbdaf0/apps/cli/src/mcp/session-history-page.ts) with local byte positions instead of Loro indices. Long entries carry `truncated`/`omittedBytes`: measured UTF-8 losses from normalized text/formatted input, plus page-level title/text/input clipping. Synthetic markers, unknown fragments and skipped records are not counted as measured source loss; machine pages omit UI clip markers. `partial` identifies a group cut by a read boundary, while `notice` separately exposes skipped, malformed or unavailable records. A long group may recur on intermediate pages with the same entry ID and `partial: "head"`; group duplicates by ID and prefer a complete version when available, but do not concatenate fragments and claim a reconstructed full result. A bounded activity page is not a complete final answer; use `result` with the original run identity for that. Cancellation rejects instead of publishing a partial success page.

## 4. `subagent_reply`: answer a specific request

Retain the parameters: `id`, `questionId` and `reason` are required; supply exactly one of `confirmed`, `value`, `answers` or `cancelled: true`, matching the request type.

| Request type | Answer |
|---|---|
| confirm | A confirmed boolean, or cancellation |
| Task question with `parentPolicy.text: true` | An offered label or custom text in `value`, submitted once, or cancellation |
| Codex/Claude task form with `parentPolicy.answers: true` | One `answers` object mapping every `fields[].id` to a string array, or cancellation |
| Other select | The value of a currently valid option, or cancellation |
| input/editor | Text in value, or cancellation |

The request must belong to the current parent session and specified instance and must not be resolved or expired. The tool implementation sets the actor to parent; the model cannot supply `actor: human`. The parent handles both ordinary questions and permission requests within the user’s authorization. `parentPolicy` describes supported responses, not proof of authorized or single-action effects. Ordinary Pi dialogs expose their native select choices, confirm boolean or input/editor text without button-label classification. Escalate when context, effects or authorization are unclear, when the user explicitly requires confirmation, or when a native request is human-only. The parent must not grant session-wide or persistent permissions; for arbitrary Pi dialogs this is a decision rule, not a programmatic guarantee about option semantics. Native backend restrictions and refusal-only legacy records remain unchanged.

Return the current state and actual response-receipt result. Acceptance can precede a matching native dialog; it does not claim delivery or completion of the requested operation. Preserve existing local decision records. Ordinary send operations cannot bypass these checks.

Keep this tool separate so approval responses remain distinguishable from ordinary lifecycle operations; do not turn it into an automatic approval policy.

Pi additionally receives a bundled, child-only `subagent_ask_parent` resource at launch and resume. Its recognized tool call creates one logical request with option labels, `kind: "question"` and `parentPolicy.text: true`. Following Paseo, the adapter caches one answer and defers native UI until the answer is available. An option label maps to its original menu entry; custom text selects the custom-answer entry and automatically fills the subsequent input. Every consumed dialog must match its active call, versioned title, expected stage and full shape. Tool completion and shutdown discard cached answers. A failed UI write fails the run instead of silently losing or replaying the answer. Replies stay in the same native turn; no extra parent reply or user prompt is needed. Unmatched dialogs are presented as separate generic requests for the parent to review; they do not consume cached answers. Native permission restrictions in other backends are unchanged. This is not a general-purpose messaging channel or a permission grant. Protocol/mapping and local lifecycle checks do not establish real-model collaboration acceptance.

Codex `item/tool/requestUserInput` is normalized into `method: "form"`, `kind: "question"`, `fields` and `isBlocking`. Each field retains its native ID, header, question, option labels/descriptions, `allowOther` and `isSecret`; duplicate headers do not merge distinct IDs. Answers preserve exact strings and map to native `{ "answers": { "<field-id>": { "answers": ["text"] } } }`. Supply all current field IDs, using an empty array to skip a field; cancel the entire request with `cancelled: true` (native empty answers map). Missing/extra IDs, wrong types and unoffered choices without `allowOther` are rejected before audit or delivery. No answer is guessed.

A non-blocking form does not set phase to waiting or prevent running steer, but a steer is never a form answer. Requests expire on native resolution or turn completion, not on deprecated `autoResolutionMs`; late answers are not rerouted to another turn. Delivery is attempted only once and waits for native request resolution, not proof of execution. An uncertain response must be inspected, never resent. Human entry collects all fields before one reply; cancelling any entry cancels the entire form. `isSecret` is metadata and a visibility warning, not secret storage or masked input.

The supported native shape is checked against Codex 0.159.2; requests declaring `multiSelect: true` and malformed/unscoped payloads fail closed rather than being silently narrowed. Native MCP approvals also use this channel: [the pinned upstream code](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/mcp_tool_call.rs) maps answers to session/persistent grants. The host-owned `mcp_tool_call_approval*` namespace and input tied to known command/file/MCP action items are therefore excluded from task forms. The recognized single-call MCP case is handled as a separate permission below; other malformed or unscoped action-owned input retains the unsupported-run failure. The action-item guard follows native event order; the reserved-ID guard does not depend on it. New native approval conventions require another contract audit. Codex treats task answers as trusted user input, just like delegated prompts: the parent must stay within the user’s original authorization, not invent authorization because it received a question. Local fixtures/schema checks do not establish real-model Codex acceptance.

### Codex MCP prefix approval (0.159.2 contract)

A blocking `item/tool/requestUserInput` (or the existing `tool/requestUserInput` alias) with exactly one `mcp_tool_call_approval_<callId>` question may represent a native MCP permission, not task context. It must match a live `mcpToolCall` item from the same active thread/turn with a server, tool and arguments. The native question must offer the known Allow/Cancel choices, no custom or secret answer shape, and no mixed task fields. The complete review details must fit the existing 12000-character budget. Missing, stale or mismatched action evidence fails closed, not by guessing from the title.

The parent receives `method: "select"`, no task-question kind/fields, and `parentPolicy.values: ["Allow", "Cancel"]`. Use one `value` or `cancelled: true`; both parent and human paths reject session/persistent choices. The adapter returns one original-RPC-ID answer map keyed by the original reserved question ID, containing exactly `"Allow"` or `"Cancel"`. Cancellation uses the native Cancel choice; it does not promise the CLI will continue the turn. No new user task, configuration change or permission amendment is sent.

Before sending, the adapter rechecks the active turn and captured action. Native resolution, turn end and an attempted uncertain write prevent duplicate responses. The worker still audits actor, reason and exact selected option before transport; this is intent, not proof the MCP tool executed. Ordinary questions remain on their existing answers contract. Other approval kinds and unknown forms remain unsupported; the separate elicitation entry has the contract below. There is no CLI version gate; fixed-source shape checks and fail-closed boundaries limit compatibility. These mappings are tested with local fixture processes, not a real MCP/model acceptance run.

### Codex MCP elicitation approval (0.159.2 contract)

`mcpServer/elicitation/request` must carry `_meta.codex_approval_kind: "mcp_tool_call"`, a `form` (including legacy `openai/form` / `openaiForm`) with no input properties or required fields, and the current non-null thread/turn. An explicit null schema is accepted as the legacy message-only shape; otherwise the typed object schema allows only `type`, `properties`, optional empty/null `required`, and optional string/null `$schema`. No schema URI is fetched. URL/login flows, data forms, unknown kinds (including `tool_suggestion`) and malformed schemas fail closed.

This request has no native item ID: exactly one live MCP call on its `serverName` must exist in the active turn. Completed calls and calls on other servers do not create ambiguity; multiple live calls on that server are refused, not selected by arrival order. The actual native action supplies the displayed server/tool/arguments; presentation metadata is not substituted for them. The captured action is rechecked before replying.

The request is a permission `confirm`, not a task question. `confirmed: true` returns `{ action: "accept", content: null, _meta: null }`; false returns `decline`, and `cancelled: true` returns `cancel`, with the same null fields. No session/always candidates are exposed to either parent or human UI. Neither content nor persistence metadata is forwarded: native Codex can interpret both as broader grants. See the [pinned native conversion](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/mcp_tool_call.rs#L2122). No native feature gate is changed. Audit records only actor/reason/decision, not arguments or credentials; it records intent, not completion of the MCP effect. Resolution/turn end/uncertain writes retain the existing no-replay contract.

### Claude task questions (2.1.283 contract)

The built-in `AskUserQuestion` is a call-correlated `can_use_tool` request, normalized to `kind: "question"`, `method: "form"` and `fields`. Its native `requires_user_interaction: true` means the card needs actual answers, not a one-tap approval. Only this known, fully decoded card may use the structured response path; other dedicated/local-only dialogs, MCP identities and unscoped requests still fail closed. `classifier_approvable: false`, rule-forced asks and `matched_ask_rule` retain the human-only restriction. The parent can always cancel rather than answer.

The decoder covers 1–4 choice/text/number questions, exact question text as field ID, unique option labels, multi-select, optional previews and native hints. Headers may repeat; native string fields are preserved even when empty or whitespace-only. Text/number hints (including ranges and defaults) are displayed, not automatically chosen or coerced; the native card permits freeform strings. Text/number cards appear only when the native extended-question feature is enabled (`CLAUDE_CODE_QUESTION_EXTENDED` / SDK `askUserQuestion.extendedQuestions`); this extension does not set it. Display controls are escaped without changing field IDs, option labels or answers. Previews are presented as text, not executed or rendered HTML. Unknown shapes and pre-existing host-answer fields (`answers`, `annotations`, `response`, `followUp`, `afkTimeoutMs`) are refused rather than overwritten or silently dropped. Requests exceeding the existing 12000-character disclosure budget also fail closed; they are not truncated into an answerable card.

Supply every exact field ID with an array. Explicit `multiSelect: false` allows zero or one string; `true` allows at most the option count plus one custom answer. The existing Codex shape omits this property and keeps its previous array contract. Single/text/number answers map to a native string (`[]` becomes an empty string); multi-select arrays are passed unchanged and the native path owns their output serialization. There is no header fallback or first-option default. This extension checks the audited strict-card bounds before the intent audit and again at transport: 8192 UTF-16 code units per string, 32768 for strict-card-encoded answer text, and 48000 including answered question keys.

The response is one `control_response` bound to the original request/tool-use/message: `behavior: "allow"` with the unchanged shown input plus `answers`, without `updatedPermissions`. This only supplies context to the read-only question tool; it is not permission for the proposed actions. `cancelled: true` uses `behavior: "deny", interrupt: false`, declining the questions without explicitly stopping the entire turn. Native cancellation, terminal results and shutdown remove pending requests; an uncertain write is never replayed. Native stdio has no separate answer receipt, so a successful write is not proof of tool execution. Human entry collects all fields, toggles multi-select choices locally, and sends either one complete answer or one cancellation.

Local parser, protocol, public-tool, audit and human-entry tests cover this mapping. Native startup and extracted admission-helper probes are separate from a real Claude turn: no model-driven `AskUserQuestion` round trip is claimed or authorized by this document. The extracted admission helper belongs to a native strict-policy branch; its activation on this stdio launch path, including its rejection and quoting behavior, has not been established. The extension applies its own checks without relying on native enforcement. The public SDK reference is [Handle approvals and user input](https://platform.claude.com/docs/en/agent-sdk/user-input); the stricter bounds and card-field rules were checked against the installed 2.1.283 executable.

## 5. `subagent_workspace`: managed worktrees

| action | Required | Optional | Returns |
|---|---|---|---|
| `create` | None | `includeUncommitted: { reason }` | Workspace id, path/cwd, baseline, revision, state, parent-directory uncommitted changes and occupation information |
| `integrate` | `workspace` | None | workspace, status, changedFiles and patchFile where applicable |

Create uses the repository containing the current Pi working directory. It defaults to committed HEAD and must not silently inherit uncommitted changes. Inheriting all current uncommitted changes requires explicit authorization. Do not add creation from arbitrary refs, branches or PRs in this phase.

Integrate applies the workspace's unintegrated changes to the original parent directory, retaining records and patches. It does not change the parent's index, HEAD or branches, or automatically commit, push or remove the worktree. Return states remain `applied | already_integrated | no_changes`.

Preserve these technical boundaries:

1. Correct workspace ownership and repository identity; operation locks and execution occupation are checked.
2. Valid baselines and sync records; unfinished or uncertain operations cannot be retried blindly.
3. Conflicts and parent-file changes are checked before applying; previously integrated increments are not applied again.
4. Starting or continuing in the same workspace uses the same occupation checks; raw cwd cannot bypass known managed-workspace constraints.
5. Errors retain enough recovery evidence; do not automatically delete files, restore old baselines or force-apply patches.

Workspace lifecycle is independent of any one agent: a workspace may pass to another instance after the previous one finishes. Do not automatically classify the new instance as a reviewer or enforce a role order.

Source-review correction: `WorkspaceStore.apply()` checks occupation, repository, baseline, patches and conflicts, but has no hard gate that reads reviewer results or checks PASS. Earlier independent-review requirements primarily lived in tool descriptions and the skill. The four-tool migration made that workflow wording neutral while preserving technical safety checks.

### Parallel isolation example

```text
workspace.create -> W1        workspace.create -> W2
subagent.start(workspace=W1)  subagent.start(workspace=W2)
          Each runs independently; results return automatically
Check results according to the user's workflow, then workspace.integrate each
```

Here workspace.* is documentation shorthand; actual calls use `subagent_workspace(action=...)`. This is not an automatic default pipeline. Tasks that do not need isolation can still specify cwd or use the current directory.

## 6. Role discovery and automatic return

The `subagent` tool description lists currently effective role names and short descriptions. It does not include full instructions, encourage selection by model tier, or require an initial query to discover roles. The extension resolves role configuration; query tools are for instances, not initial role discovery.

Catalog generation must respect project trust and configuration precedence. The implementation re-registers the dispatch tool description at session_start, before_agent_start and after settings are saved, without rewriting the entire prompt. Configuration replacement, trust changes and removal of stale catalogs after invalid configuration have been verified. External file changes during a turn appear at the next catalog refresh; startup still resolves the effective configuration at call time.

Codex roles additionally accept the optional boolean `defaultModeQuestions`; it is a role setting, not a `subagent.start`/`send` override. `true`/`false` map only to the process-scoped `-c features.default_mode_request_user_input=<boolean>` argument; omission sends no override. The settings pane calls omission `inherit` but never serializes that string. CLI 0.159.2 defaults this experimental Default-mode feature to off. It does not select Plan or change model, reasoning effort, approval policy, sandbox, or the independent `tools.experimental_request_user_input.enabled` registration gate. Pi/Claude roles reject this field; switching away from Codex removes it. Role changes apply to new instances only; an existing instance retains the saved setting at every native launch/resume. No global config or old spec is rewritten. The compact role summary does not repeat this flag; it is visible in the Codex field editor. CLI configuration probes and local form fixtures are not real-model question acceptance.

Zero-model checks with 0.159.2 covered both native on/off baselines and all three role values via `features list` and the production adapter’s `initialize` → `thread/start` → `config/read`, with unchanged config files and clean exits. Initial launch and saved-role resume are covered by local protocol tests. Native cross-process resume was not covered: an empty zero-turn thread returned a future rollout path but created no rollout, so a later `thread/resume` returned `no rollout found`. The failed probe is not counted as a pass; real question delivery and resume of a thread with actual history remain separate acceptance work.

Results and actionable blockers use the existing automatic notification channel; the child does not need a separate reporting tool. Notifications bind the original parent session, instance and run and provide the new result query entry point. Long originals use a preview plus full-text pagination, without deleting evidence.

Notification semantics: an idle parent may be triggered to handle the event. A batch containing a waiting request uses `steer`, reaching a busy parent before its next model request without aborting an in-flight tool; other batches use `followUp`. This differs from the original all-follow-up implementation and is independent of `subagent.send.mode`. The queue is not a persisted receipt. Resuming the original parent can redeliver unrecorded notifications, while recorded notifications are deduplicated by ID. This is not an exactly-once guarantee under every failure mode.

Direct human-action records use a separate `human-actions/ha-<uuid>.json` outbox beside the instance. The plain manager identity survives context replacement; old Pi contexts are not used to write another session. Current-parent delivery runs before report delivery, uses `cli-subagents-human-action` with `details.actionId`, and sends `triggerTurn:false` without steer/followUp. Pi 0.87.1/1.1.0 SDK-path probes confirm idle append and busy turn-end append without a new model turn. The full-session custom-message receipt, not the pending set, proves persistence. Switching/reopening can redeliver a saved but unrecorded message; this never replays the child operation. Bad sources are isolated and kept as evidence. Records are written after the UI operation returns; process failure before that write is outside this notification recovery contract.

The `/agents` roster also offers a human-only `c` action: confirm the listed v2 idle runtimes with no pending questions, then release each captured instance/run/runtime through the existing close path. Both the manager and the worker queue reject changed identity or non-idle targets; newly busy or replacement runtimes must not be stopped by an older list. This is not archive/delete or a bulk model tool. Each result or refusal is reported and recorded for the original parent; failures do not replay successful releases. Cancelling confirmation performs no operation, and a parent-session switch stops the remaining batch while retaining an already in-flight action for its original parent. Idle background work may be stopped; session/history/files and completed reports remain.

The extension does not decide that the parent must implement, review or integrate after receiving a result. This phase adds no general-purpose proactive child-to-parent messaging tool.

## 7. Migration strategy and verification gates

Do not expose the new four tools and old seven tools to the model simultaneously. Update tool descriptions, the skill, notification result-reading hints and relevant tests together; do not keep permanent parallel entry points solely to preserve old tool names.

Preserve original sessions, instance IDs, run IDs, role snapshots and workspace records. Renaming tools must not create new instances or rewrite old reports. Old tool-call hints in historical notifications remain original history. Current usage guidance names only supported tools. Read historical notifications using their original instance/run IDs with `subagent_query`, without editing old evidence.

| Verification area | Required evidence |
|---|---|
| Tool definitions | Only four tools exposed; role catalog reflects effective configuration; action-level validation rejects unknown or inapplicable fields |
| Lifecycle mapping | Start creates a new instance; send continues the original identity; unsupported modes fail explicitly; timeouts/rejections do not trigger automatic replacement |
| Queries and replies | Queries have no execution side effects; full results can be reconstructed; reply ownership, expiration, type and humanOnly behavior do not regress |
| Workspaces | Two instances use separate worktrees; one workspace supports sequential handoff; conflict rejection, incremental integration and baseline continuation remain correct |
| Notifications and compatibility | Delivery to the original parent; waiting-request steering and routine follow-up queuing; recovery redelivery; old instances and runs remain readable; historical notifications are unchanged |

Issues such as roles being overridable but not currently removable, uncertain startup receipts, and corrupt reports affecting a notification batch are separate from merging tools. Verify them with counterexamples and separate increments rather than packing every reliability fix into a tool rename.

During the four-tool migration, serialized name/description/parameters JSON fell from 6,279 to 5,147 bytes. That measurement preceded the dynamic role catalog and is not a final token count. Having 4 tools rather than 7 does not by itself mean correct usage is easier. Continue to prioritize local tests and fake CLIs; real calls require separate authorization.

## 8. Current evidence and unverified items

The contracts were checked against `src/index.ts`, `src/types.ts`, `src/manager.ts`, `src/notifier.ts`, `src/worker.ts`, `src/roles.ts`, `src/workspace.ts` and the existing skill. This draft introduced no runtime types, state tables, databases or queue implementations.

Implementation commits: `4b46bdc` (four-tool migration), `29de2e4` (effective role catalog) and `b406426` (follow-up notifications). At that baseline, all 385/385 local tests and typecheck/build passed, as did tool-refresh probes using the project's dependency and the installed Pi loader. Notification tests use actual SDK routing methods with controlled execution stubs, covering busy queuing, original-run redelivery after queue loss and persisted-receipt deduplication; this is not acceptance of the complete model loop.

At that four-tool migration baseline, no real models, real CLI collaboration or independent agent review were run. @-dispatch, new multi-entry-point behavior and real-endpoint compatibility remain unverified.

Next step: reload the extension to inspect the tools and role catalog; real collaboration acceptance requires separate authorization.
