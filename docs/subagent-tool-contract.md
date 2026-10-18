# CLI Subagent 三工具接口

当前入口为 `subagent`、`subagent_query`、`subagent_reply`：工作区 create/integrate 已并入 `subagent` 的显式动作，能力、记录格式和安全校验不变，不保留旧工作区工具别名。下文四工具阶段的提交、测试数字与测量保留为历史证据，不代表本次合并的真实模型验收。

The current scope covers only CLI subagent dispatch and management by the parent Pi agent. `@role` and a new direct user dispatch entry point are deferred; the existing user management UI remains. This document refines the product goals and does not authorize further code changes, real dispatch or model calls.

## 1. Design conclusion

使用三个根对象工具：`subagent` 管理实例及工作区，`subagent_query` 只读查询，`subagent_reply` 答复原请求。动态角色目录仍直接放在调度工具说明里；合并入口不删除原生会话、历史结果或工作区能力，也不新增不透明 options。

| Tool | Operations | Existing capability source |
|---|---|---|
| `subagent` | `start` / `send` / `interrupt` / `stop` / `reclaim` / `workspace_create` / `workspace_integrate` | Instance lifecycle and existing `WorkspaceStore.create` / `integrate` |
| `subagent_query` | `list` / `get` / `result` / `activity` | Existing inventory/result reads plus bounded projected history |
| `subagent_reply` | Answer one specific request; no action required | `respond_to_permission` |

Do not add automatic task assignment, automatic instance reuse, model overrides, mandatory reviews, automatic retries or an automatic worktree policy. Workspace actions remain available normally; the user and parent agent decide whether to use them, without an additional opt-in switch.

The following is a logical parameter contract, not the final TypeBox/JSON Schema code. Each action has its own required and allowed fields; inapplicable fields must be rejected rather than silently ignored. The implementation uses a root-object schema with additional action-level field checks before execution. Local interface tests have passed; neither documentation examples nor local success establish compatibility with every model endpoint.

## 2. `subagent`：实例生命周期与工作区

### 2.1 Parameters

| action | Required | Optional | Semantics |
|---|---|---|---|
| `start` | `role`, `task` | `cwd` or `workspace` | Create an instance and execute its first task; cwd and workspace are mutually exclusive |
| `send` | `id`, `message` | `mode`, `baseline`, `includeUncommitted` | Deliver instructions while running, or begin a new run in the same native session after completion |
| `interrupt` | `id` | None | End only the captured current turn, retaining a usable runtime; unsupported backends reject |
| `stop` | `id` | None | Release native resources of an instance with no accepted turn in flight; a turn in flight must be interrupted first, because releasing would discard it. Retains the native session and history; do not delete files or roll back changes |
| `reclaim` | `id`, `runtimeId` | None | Free the **accounting** of one unreachable runtime whose recorded worker and CLI are both reliably gone. Not a native release: it confirms no native release, leaves `state.json` and `owner.lock` untouched, and does not make the instance resumable. Refuses when either pid exists or its absence cannot be established (only an `ESRCH` observation counts), when ownership conflicts, when `cliPid` is missing, or when the named runtime is not the recorded one. Evidence covers only the two recorded pids: any process the CLI started is outside its scope, and a reclaim never claims those descendants have stopped |
| `workspace_create` | None | `includeUncommitted: { reason }` | 从当前 Pi cwd 所属仓库的已提交 HEAD 创建托管工作树；见 §5 |
| `workspace_integrate` | `workspace` | None | 向原父目录集成该工作区的待集成改动；见 §5 |

`start` defaults to the current Pi working directory; when workspace is specified, resolve its actual path from the record. The role must exist in the current effective configuration. Resolve CLI, provider and model from role configuration; do not expose per-run model-routing parameters. task/message must be non-empty.

`send.mode` remains `steer | followUp`, defaulting to steer. It controls how the child receives instructions, not how result notifications are delivered to the parent agent.

| Target state / CLI | `send` behavior |
|---|---|
| Running Pi | Deliver using the selected steer/followUp mode; receipt does not imply execution |
| Running Codex | Use the supported steer path; explicitly reject followUp |
| Running Claude | steer uses native non-aborting priority next; followUp uses priority later. Require msg_lifecycle_v1 and a correlated native input receipt |
| Unresolved blocking interaction request | Direct the caller to `subagent_reply` or the user interaction entry point; ordinary messages are not approvals |
| Idle Pi/Codex/Claude runtime | Begin a new run in the same worker/CLI; retain the native session and runtime identity |
| Closed, with a recoverable original session | Resume the original session in a new runtime; never replay a prior assignment |
| Missing session, unclear occupation or uncertain state | Reject with diagnostic guidance; do not silently create a replacement |

These CLI capabilities describe the current implementation, not a promise that every upstream version will behave identically forever.

New Pi/Codex/Claude workers remain resident after a run ends: `phase: idle` describes the runtime, while `lastStatus` and the immutable per-run report describe the outcome. `stop` releases an idle runtime and refuses one whose accepted turn is still in flight, which must be interrupted first; it never rewrites an already finished report. Claude resets per-run UUID/result/approval state, correlates all submitted inputs, and waits for the native queue and background-work barriers before idle. Independent interruption requires interrupt_receipt_v1 and interrupt_cancel_queued_v1, confirms no surviving queued work, and waits for the captured terminal result without closing stdin. Missing capabilities reject before dispatch; uncertain outcomes block new work until explicit stop. Local fixtures cover these paths; real Claude multi-turn acceptance is NOT_RUN. Residency preserves the opportunity for background work, not permanent process survival or authorization for more model work. A confirmed native exit becomes closed with a distinct runtime notice; missing worker/ownership proof becomes unreachable and prevents replacement work.

New control endpoints use protocol v2, `runtimeId` and an expected current `runId`; stale or legacy control requests cannot operate a v2 worker. Existing workers are not hot-replaced. Only after confirmed native release is a terminal snapshot persisted with `runtimeClosed: true`, retaining old terminal enums for downgrade readers; the current manager exposes this as closed. Interrupt is public with captured-run confirmation and no replay after uncertainty; it does not substitute for release. A release receipt returns the release proof together with instance metadata, and does not repeat the retained report; read that run's text with `subagent_query result` by the same identity. Each run writes its own instance-contained events file, so the manager lists one source per run instead of one shared runtime log. An instance drops the oldest runs' raw streams once they exceed a fixed budget: the request record, the report, the state and the native session of a pruned run are retained, and the surviving files keep their bytes because activity cursors and the transcript window read them by offset. The budget is enforced when a run starts, so the run in progress, the stderr companion of the launch run and an instance that never runs again may exceed it. Queries do not start a CLI.

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

### 2.3 Runtime admission caps（`MAX_ACTIVE` / `MAX_RESIDENT` / 旧 `MAX_RUNTIMES`）

一个父会话有两个互相独立的并发上限，跨角色统一计数，作用域是这个父进程（不是机器级、不是全局）：

| 变量 | 默认 | 计数对象 |
|---|---|---|
| `PI_CLI_SUBAGENTS_MAX_ACTIVE` | **4** | 可能仍在执行的轮次：`starting/running/waiting/stopping`，以及执行状态未知的 `unreachable` |
| `PI_CLI_SUBAGENTS_MAX_RESIDENT` | **12** | 尚未确认释放的托管 runtime（口径见下） |

- **`0` 的含义**：每个维度可单独用 `0` 关闭；**两个维度都写 `0`** 才完全恢复不限。只写 `RESIDENT=0` 不会解除 active 上限。
- **旧变量**：`PI_CLI_SUBAGENTS_MAX_RUNTIMES` 继续表示 **resident**；它的 `0` 由非法变为合法。旧变量与新 `MAX_RESIDENT` 同时出现即**拒绝**（即使数值相同），避免隐含优先级；旧变量与新 `MAX_ACTIVE` 可以同时配置。
- **破坏性变更（必须显式声明）**：旧合同为「变量缺失 = 不启用上限」，现改为「未配置即 4 / 12」。要恢复旧行为须同时设置 `MAX_ACTIVE=0` 与 `MAX_RESIDENT=0`。
- **占用口径（resident）**：runtime 从创建那一刻起占一个名额，直到**释放被确认**（`phase=closed` 且 `runtimeClosed=true`）才归还。`starting/running/waiting/stopping/idle` 与带终态的 `completed/failed/stopped` 全占；`closed` 但缺 `runtimeClosed` 的未确认释放**仍占**；记录不可读（`unreachable`）**仍占**。
- **唯一例外：`reclaim`**。不可达 runtime 只有在**显式** `reclaim` 且 worker 与 CLI 两个记录 PID 都得到 `ESRCH` 观察后，才停止计入 active/resident。凭据写在实例目录的 `reclaims/<runtimeId>.json`（一 runtime 一份，**创建后不覆盖**；重复调用仅在身份与所有权仍匹配时返回原证据，否则拒绝）。生效条件（同时满足）：记录内容绑定当前父会话、实例与**同一个** `runtimeId`；证据结构完整且判据为 `ESRCH`；`owner.lock` **不存在**或 runtimeId 与 pid 均与记录一致。以下情形**回收记录不生效**且该 runtime 继续占位：当前 `owner.lock` 属于另一个 runtime（所有权冲突）、`phase` 不是 `unreachable`、内容无效或不可解析。回收不影响未结算的准入预留，也不解除 workspace 写入排他或允许恢复原会话。**证据边界**：`reclaim` 只处理记录中的 `workerPid` 与 `cliPid`；CLI 派生的孙进程（后台 server、长跑任务）既不在记录里也不在证据范围内，所以"账目已回收"不等于"该 runtime 启动的所有工作都已停止"。`subagent_query` 的 `get`/`list` 会返回 `reclaimed: { at, evidence, nativeReleaseConfirmed:false, continuation:"blocked" }`（`at` 为观察时间；`evidence` 含两个 PID 与 `ESRCH` 判据），因此回收后的实例在查询里仍可辨别，而不会看起来像已正常关闭。
- **计数来源**：每次准入都从磁盘重算（`manager.list()`），因此跨 controller / 跨工具调用一致。
- **准入点**（三条）：新建实例（`start`）、对**已释放实例**的 `send` 恢复、以及**对 `idle` 实例开启新 run 的 `send`**。最后一条只判 active、不判 resident——该实例已经占着 runtime 名额，新 run 不新增 runtime。
- **并发**：每次准入成功先做一次**进程内轮次预留**，直到该轮次的 runId 对磁盘可见；预留按「实例 + 前一个 runId」判定撤销，所以「实例已在列表中可见」本身**不会**撤销预留（`idle` 实例天然可见）。无法确认结果（超时等）不因 `finally` 就归还名额，须等磁盘出现该轮次或该实例可被证明未启动。
- **拒绝语义**：**显式拒绝**，不排队、不抢占，且发生在任何目录/进程/人工动作记录之前。错误消息给出 `占用数 of 上限` 与产生该上限的变量名；**不建议任何驱逐动作**（不提示「去释放一个」）。
- **非法值**：空字符串、空白、负数、非整数（含小数、字母）= 显式报错并拒绝派发，避免「看着设了限其实没设」；空字符串**不会**被读成 `0`。

### 2.4 Examples

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

Keep the workspace inventory in `list` so reusable workspaces and their occupation can be discovered without a separate workspace-list tool. `get` may include necessary information about the instance's associated workspace; do not add cross-parent-session scanning.

The result action retains the current pagination contract: offset defaults to 0; limit defaults to and cannot exceed 12000 UTF-16 code units. Return `agentId`, `runId`, `status`, `time`, `error`, `offset`, `totalLength`, `nextOffset` and `text`. Keep id/runId fixed and follow nextOffset until null.

Reject missing, corrupt, cross-instance or cross-parent-session results. A missing original report cannot be replaced with the current latest result. Reading must not start, wake or stop an instance, or approve an operation. Neither a result preview nor terminal state proves acceptance of the business outcome.

### Activity paging

Activity uses the same pure transcript reader as the viewer, not a raw transport dump. It returns `{ id, entries, hasMore, cursor?, notice? }`; entries are chronological within each page and only recognized messages, tool activity and notices are projected. `limit` defaults to 20 and must be 1–100. `maxBytes` defaults to 16384 and must be 4096–65536; the limit covers the entire JSON response in UTF-8, including cursor and metadata. Invalid limits are errors, not silently clamped values.

The first call reads a bounded recent tail. Pass the returned opaque cursor unchanged to read older entries; no cursor means a new recent-tail query. Versioned cursors bind the instance/backend and a real log byte position with a bounded file-identity/anchor witness. Foreign, malformed or detected stale cursors fail rather than silently jumping to the tail. Normal append-only growth remains valid. This is not a whole-history integrity check: arbitrary far-away in-place edits outside the witness are not guaranteed detectable. No cursor store, CLI startup/resume, native-history rewrite or background scan is introduced.

Byte trimming keeps dropped older entries reachable through the next cursor, following [Lody's pinned history-page contract](https://github.com/LodyAI/Lody/blob/6dc434952ab2e942291cc8392316bf760afbdaf0/apps/cli/src/mcp/session-history-page.ts) with local byte positions instead of Loro indices. Long entries carry `truncated`/`omittedBytes`: measured UTF-8 losses from normalized text/formatted input, plus page-level title/text/input clipping. Synthetic markers, unknown fragments and skipped records are not counted as measured source loss; machine pages omit UI clip markers. `partial` identifies a group cut by a read boundary, while `notice` separately exposes skipped, malformed or unavailable records. A long group may recur on intermediate pages with the same entry ID and `partial: "head"`; group duplicates by ID and prefer a complete version when available, but do not concatenate fragments and claim a reconstructed full result. A bounded activity page is not a complete final answer; use `result` with the original run identity for that. Cancellation rejects instead of publishing a partial success page.

## 4. `subagent_reply`: answer a specific request

人工答复仅走 TUI：`/agents` → 选择实例 → `i` 详情 → `r` 答复；删除 `/agent-reply` 命令，不保留别名。面板按待答请求而非 `waiting` 状态提供答复，因此也覆盖仍在 `running` 的 Codex 非阻塞问题。保留 `replyPrompt()`、父代理工具、原请求校验及人工操作回执；历史通知不改写。

Retain the parameters: `id`, `questionId` and `reason` are required; supply exactly one of `confirmed`, `value`, `answers` or `cancelled: true`, matching the request type.

| Request type | Answer |
|---|---|
| confirm | A confirmed boolean, or cancellation |
| Task question with `parentPolicy.text: true` | An offered label or custom text in `value`, submitted once, or cancellation |
| Codex/Claude task form with `parentPolicy.answers: true` | One `answers` object mapping every `fields[].id` to a string array, or cancellation |
| Other select | The value of a currently valid option, or cancellation |
| input/editor | Text in value, or cancellation |

The request must belong to the current parent session and specified instance and must not be resolved or expired. The tool implementation sets the actor to parent; the model cannot supply `actor: human`. The parent handles both ordinary questions and permission requests within the user’s authorization. `parentPolicy` describes supported responses, not proof of authorized or single-action effects. Ordinary Pi dialogs expose their native select choices, confirm boolean or input/editor text without button-label classification. Escalate when context, effects or authorization are unclear, when the user explicitly requires confirmation, or when native policy signals in the request (classifier not approvable, rule-forced asks) cannot be justified within the user's authorization. The parent must not grant session-wide or persistent permissions; for arbitrary Pi dialogs this is a decision rule, not a programmatic guarantee about option semantics. Native backend restrictions and refusal-only legacy records remain unchanged.

Return the current state and actual response-receipt result. Acceptance can precede a matching native dialog; it does not claim delivery or completion of the requested operation. Preserve existing local decision records. Ordinary send operations cannot bypass these checks.

Keep this tool separate so approval responses remain distinguishable from ordinary lifecycle operations; do not turn it into an automatic approval policy.

Pi additionally receives a bundled, child-only `subagent_ask_parent` resource at launch and resume. Its recognized tool call creates one logical request with option labels, `kind: "question"` and `parentPolicy.text: true`. Following Paseo, the adapter caches one answer and defers native UI until the answer is available. An option label maps to its original menu entry; custom text selects the custom-answer entry and automatically fills the subsequent input. Every consumed dialog must match its active call, versioned title, expected stage and full shape. Tool completion and shutdown discard cached answers. A failed UI write fails the run instead of silently losing or replaying the answer. Replies stay in the same native turn; no extra parent reply or user prompt is needed. Unmatched dialogs are presented as separate generic requests for the parent to review; they do not consume cached answers. Native permission restrictions in other backends are unchanged. This is not a general-purpose messaging channel or a permission grant. Protocol/mapping and local lifecycle checks do not establish real-model collaboration acceptance.

Codex `item/tool/requestUserInput` is normalized into `method: "form"`, `kind: "question"`, `fields` and `isBlocking`. Each field retains its native ID, header, question, option labels/descriptions, `allowOther` and `isSecret`; duplicate headers do not merge distinct IDs. Answers preserve exact strings and map to native `{ "answers": { "<field-id>": { "answers": ["text"] } } }`. Supply all current field IDs, using an empty array to skip a field; cancel the entire request with `cancelled: true` (native empty answers map). Missing/extra IDs, wrong types and unoffered choices without `allowOther` are rejected before audit or delivery. No answer is guessed.

A non-blocking form does not set phase to waiting or prevent running steer, but a steer is never a form answer. Requests expire on native resolution or turn completion, not on deprecated `autoResolutionMs`; late answers are not rerouted to another turn. Delivery is attempted only once and waits for native request resolution, not proof of execution. An uncertain response must be inspected, never resent. Human entry collects all fields before one reply; cancelling any entry cancels the entire form. `isSecret` is metadata and a visibility warning, not secret storage or masked input.

The supported native shape is checked against Codex 0.159.2; requests declaring `multiSelect: true` and malformed/unscoped payloads are answered with an empty native answer set (the native abort) rather than being silently narrowed, and the run continues. Native MCP approvals also use this channel: [the pinned upstream code](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/mcp_tool_call.rs) maps answers to session/persistent grants. The host-owned `mcp_tool_call_approval*` namespace and input tied to known command/file/MCP action items are therefore excluded from task forms. The recognized single-call MCP case is handled as a separate permission below; other malformed or unscoped action-owned input receives the same empty answer set and, since 2026-10-11, no longer fails the run. The action-item guard follows native event order; the reserved-ID guard does not depend on it. New native approval conventions require another contract audit. Codex treats task answers as trusted user input, just like delegated prompts: the parent must stay within the user’s original authorization, not invent authorization because it received a question. Local fixtures/schema checks do not establish real-model Codex acceptance.

### Codex asynchronous message questions (0.159.2 contract)

A completed `agentMessage` with `delivery: "async"` and non-empty `questions: [{ title, options }]` is mid-turn output, not turn completion or a JSON-RPC server request. The adapter binds it to the current native thread/turn and emits a non-blocking task form immediately through the existing waiting-report/steer route. Repeated completed-item IDs do not emit another question, even after it was answered.

Following [Paseo’s pinned mapping](https://github.com/getpaseo/paseo/blob/29db2b79809fc032860ff4e8ee360fbe0073c3e9/packages/server/src/server/agent/providers/codex/async-questions.ts), fields use local indices `"0"`, `"1"`, etc., `allowOther: true`, `multiSelect: false`, and `required: true`. Every field needs exactly one non-blank string. Empty/skipped/multiple answers are rejected before the intent audit; ordinary requestUserInput and Claude optional fields retain their skip contract.

The caller still uses `subagent_reply.answers`; the adapter formats answer text and submits one `turn/steer` with the captured `expectedTurnId`. It never fabricates a JSON-RPC response ID or sends another `turn/start`. Cancellation dismisses the local request without steering or interrupting. An uncertain steer cannot be resubmitted. As a deliberate active-run adaptation, unanswered questions expire on turn completion/interrupt/release, rather than importing Paseo’s session-persistent pending queue and idle follow-up behavior. Answers are context, never authorization.

Async messages remain in activity/history but are excluded from the terminal answer, including legacy no-phase assembly and native history recovery. The source evidence and verification limits are recorded in the project's internal notes, which are not published; a fresh real-model recheck remains separate from local fixtures.

### Codex MCP prefix approval (0.159.2 contract)

A blocking `item/tool/requestUserInput` (or the existing `tool/requestUserInput` alias) with exactly one `mcp_tool_call_approval_<callId>` question may represent a native MCP permission, not task context. It must match a live `mcpToolCall` item from the same active thread/turn with a server, tool and arguments. The native question must offer the known Allow/Cancel choices, no custom or secret answer shape, and no mixed task fields. The complete review details must fit the existing 12000-character budget. Missing, stale or mismatched action evidence is answered with an empty answer set (the native abort), never by guessing from the title.

The parent receives `method: "select"`, no task-question kind/fields, and `parentPolicy.values: ["Allow", "Cancel"]`. Use one `value` or `cancelled: true`; both parent and human paths reject session/persistent choices. The adapter returns one original-RPC-ID answer map keyed by the original reserved question ID, containing exactly `"Allow"` or `"Cancel"`. Cancellation uses the native Cancel choice; it does not promise the CLI will continue the turn. No new user task, configuration change or permission amendment is sent.

Before sending, the adapter rechecks the active turn and captured action. Native resolution, turn end and an attempted uncertain write prevent duplicate responses. The worker still audits actor, reason and exact selected option before transport; this is intent, not proof the MCP tool executed. Ordinary questions remain on their existing answers contract. Other approval kinds and unknown forms are refused per request; the separate elicitation entry has the contract below. There is no CLI version gate; fixed-source shape checks and per-request refusal boundaries limit compatibility. These mappings are tested with local fixture processes, not a real MCP/model acceptance run.

### Codex MCP elicitation approval (0.159.2 contract)

`mcpServer/elicitation/request` must carry `_meta.codex_approval_kind: "mcp_tool_call"`, a `form` (including legacy `openai/form` / `openaiForm`) with no input properties or required fields, and the current non-null thread/turn. An explicit null schema is accepted as the legacy message-only shape; otherwise the typed object schema allows only `type`, `properties`, optional empty/null `required`, and optional string/null `$schema`. No schema URI is fetched. URL/login flows, data forms, unknown kinds (including `tool_suggestion`) and malformed schemas are cancelled natively (`action: "cancel"`) while the turn continues.

This request has no native item ID: exactly one live MCP call on its `serverName` must exist in the active turn. Completed calls and calls on other servers do not create ambiguity; multiple live calls on that server are refused, not selected by arrival order. The actual native action supplies the displayed server/tool/arguments; presentation metadata is not substituted for them. The captured action is rechecked before replying.

The request is a permission `confirm`, not a task question. `confirmed: true` returns `{ action: "accept", content: null, _meta: null }`; false returns `decline`, and `cancelled: true` returns `cancel`, with the same null fields. No session/always candidates are exposed to either parent or human UI. Neither content nor persistence metadata is forwarded: native Codex can interpret both as broader grants. See the [pinned native conversion](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/mcp_tool_call.rs#L2122). No native feature gate is changed. Audit records only actor/reason/decision, not arguments or credentials; it records intent, not completion of the MCP effect. Resolution/turn end/uncertain writes retain the existing no-replay contract.

### Claude task questions (2.1.283 contract)

The built-in `AskUserQuestion` is a call-correlated `can_use_tool` request, normalized to `kind: "question"`, `method: "form"` and `fields`. Its native `requires_user_interaction: true` means the card needs actual answers, not a one-tap approval. Only this known, fully decoded card may use the structured response path; other dedicated/local-only dialogs, MCP identities and unscoped requests are denied per request (`behavior: "deny"`, no interrupt) while the turn continues. `classifier_approvable: false`, rule-forced asks and `matched_ask_rule` are surfaced to the parent as native policy signals in the request message; since 2026-10-11 they no longer limit the parent to cancellation, matching Paseo and Lody, which have no human-only carve-out. The parent can always cancel rather than answer.

The decoder covers 1–4 choice/text/number questions, exact question text as field ID, unique option labels, multi-select, optional previews and native hints. Headers may repeat; native string fields are preserved even when empty or whitespace-only. Text/number hints (including ranges and defaults) are displayed, not automatically chosen or coerced; the native card permits freeform strings. Text/number cards appear only when the native extended-question feature is enabled (`CLAUDE_CODE_QUESTION_EXTENDED` / SDK `askUserQuestion.extendedQuestions`); this extension does not set it. Display controls are escaped without changing field IDs, option labels or answers. Previews are presented as text, not executed or rendered HTML. Unknown shapes and pre-existing host-answer fields (`answers`, `annotations`, `response`, `followUp`, `afkTimeoutMs`) are refused rather than overwritten or silently dropped. Requests exceeding the existing 12000-character disclosure budget are denied the same way; they are not truncated into an answerable card.

Supply every exact field ID with an array. Explicit `multiSelect: false` allows zero or one string; `true` allows at most the option count plus one custom answer. The existing Codex shape omits this property and keeps its previous array contract. Single/text/number answers map to a native string (`[]` becomes an empty string); multi-select arrays are passed unchanged and the native path owns their output serialization. There is no header fallback or first-option default. This extension checks the audited strict-card bounds before the intent audit and again at transport: 8192 UTF-16 code units per string, 32768 for strict-card-encoded answer text, and 48000 including answered question keys.

The response is one `control_response` bound to the original request/tool-use/message: `behavior: "allow"` with the unchanged shown input plus `answers`, without `updatedPermissions`. This only supplies context to the read-only question tool; it is not permission for the proposed actions. `cancelled: true` uses `behavior: "deny", interrupt: false`, declining the questions without explicitly stopping the entire turn. Native cancellation, terminal results and shutdown remove pending requests; an uncertain write is never replayed. Native stdio has no separate answer receipt, so a successful write is not proof of tool execution. Human entry collects all fields, toggles multi-select choices locally, and sends either one complete answer or one cancellation.

Local parser, protocol, public-tool, audit and human-entry tests cover this mapping. Native startup and extracted admission-helper probes are separate from a real Claude turn: no model-driven `AskUserQuestion` round trip is claimed or authorized by this document. The extracted admission helper belongs to a native strict-policy branch; its activation on this stdio launch path, including its rejection and quoting behavior, has not been established. The extension applies its own checks without relying on native enforcement. The public SDK reference is [Handle approvals and user input](https://platform.claude.com/docs/en/agent-sdk/user-input); the stricter bounds and card-field rules were checked against the installed 2.1.283 executable.

## 5. `subagent` 的工作区动作

| action | Required | Optional | Returns |
|---|---|---|---|
| `workspace_create` | None | `includeUncommitted: { reason }` | Workspace id, path/cwd, baseline, revision, state, parent-directory uncommitted changes and occupation information |
| `workspace_integrate` | `workspace` | None | workspace, status, changedFiles and patchFile where applicable |

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

此处 workspace.* 只是文档简写，实际调用使用 `subagent({action: "workspace_create"})` 或 `subagent({action: "workspace_integrate", workspace})`。这不是自动默认流水线；无需隔离的任务仍可指定 cwd 或使用当前目录。

## 6. Role discovery and automatic return

The `subagent` tool description lists currently effective role names and short descriptions. It does not include full instructions, encourage selection by model tier, or require an initial query to discover roles. The extension resolves role configuration; query tools are for instances, not initial role discovery.

Catalog generation must respect project trust and configuration precedence. The implementation re-registers the dispatch tool description at session_start, before_agent_start and after settings are saved, without rewriting the entire prompt. Configuration replacement, trust changes and removal of stale catalogs after invalid configuration have been verified. External file changes during a turn appear at the next catalog refresh; startup still resolves the effective configuration at call time.

Codex roles additionally accept the optional boolean `defaultModeQuestions`; it is a role setting, not a `subagent.start`/`send` override. `true`/`false` map only to the process-scoped `-c features.default_mode_request_user_input=<boolean>` argument; omission sends no override. The settings pane calls omission `inherit` but never serializes that string. CLI 0.159.2 defaults this experimental Default-mode feature to off. It does not select Plan or change model, reasoning effort, approval policy, sandbox, or the independent `tools.experimental_request_user_input.enabled` registration gate. Pi/Claude roles reject this field; switching away from Codex removes it. Role changes apply to new instances only; an existing instance retains the saved setting at every native launch/resume. No global config or old spec is rewritten. The compact role summary does not repeat this flag; it is visible in the Codex field editor. CLI configuration probes and local form fixtures are not real-model question acceptance.

Zero-model checks with 0.159.2 covered both native on/off baselines and all three role values via `features list` and the production adapter’s `initialize` → `thread/start` → `config/read`, with unchanged config files and clean exits. Initial launch and saved-role resume are covered by local protocol tests. Native cross-process resume was not covered: an empty zero-turn thread returned a future rollout path but created no rollout, so a later `thread/resume` returned `no rollout found`. The failed probe is not counted as a pass; real question delivery and resume of a thread with actual history remain separate acceptance work.

结果与阻塞仍自动返回原父会话并绑定原实例/run，不新增报告工具。审批／待答正文完整呈现；普通长结果保留头尾预览，只有截断最终报告附省略区起点和有界长度的 result 定位器。分页补齐全部省略内容后无需重读已显示尾部；单独读取 result 或 get 预览仍可沿 nextOffset 读至 null。完整呈现与收到报告均不等于核验。

自动协作通知的 `waiting`、`completed`、`failed`、`stopped`、`stalled` 均使用 `steer`，在忙碌父代理的下一次模型请求前进入上下文，不取消在途工具；成功报告保留两秒合批窗口，普通活动不触发模型轮次。空闲父代理可被触发处理事件，此规则独立于 `subagent.send.mode`。队列不是持久收据：原父会话重开可补投未记录通知，已记录通知按 ID 去重；不承诺所有故障路径下 exactly-once。

Direct human-action records use a separate `human-actions/ha-<uuid>.json` outbox beside the instance. The plain manager identity survives context replacement; old Pi contexts are not used to write another session. Current-parent delivery runs before report delivery, uses `cli-subagents-human-action` with `details.actionId`, and sends `triggerTurn:false` without steer/followUp. Pi 0.87.1/1.1.0 SDK-path probes confirm idle append and busy turn-end append without a new model turn. The full-session custom-message receipt, not the pending set, proves persistence. Switching/reopening can redeliver a saved but unrecorded message; this never replays the child operation. Bad sources are isolated and kept as evidence. Records are written after the UI operation returns; process failure before that write is outside this notification recovery contract.

The `/agents` roster also offers a human-only `c` action: confirm the listed v2 idle runtimes with no pending questions, then release each captured instance/run/runtime through the existing close path. Both the manager and the worker queue reject changed identity or non-idle targets; newly busy or replacement runtimes must not be stopped by an older list. This is not archive/delete or a bulk model tool. Each result or refusal is reported and recorded for the original parent; failures do not replay successful releases. Cancelling confirmation performs no operation, and a parent-session switch stops the remaining batch while retaining an already in-flight action for its original parent. Idle background work may be stopped; session/history/files and completed reports remain.

The extension does not decide that the parent must implement, review or integrate after receiving a result. This phase adds no general-purpose proactive child-to-parent messaging tool.

## 7. Migration strategy and verification gates

只暴露三个当前工具，不并列保留旧七工具或 `subagent_workspace` 别名。旧工作区调用必须改为 `subagent` 的 `workspace_create` / `workspace_integrate`；不自动重映射或重放。外部按工具名配置的允许列表需复核新的动作边界，本次不改用户设置。同步说明、技能和测试，但不迁移既有工作区数据。

Preserve original sessions, instance IDs, run IDs, role snapshots and workspace records. Renaming tools must not create new instances or rewrite old reports. Old tool-call hints in historical notifications remain original history. Current usage guidance names only supported tools. Read historical notifications using their original instance/run IDs with `subagent_query`, without editing old evidence.

| Verification area | Required evidence |
|---|---|
| Tool definitions | Only three tools exposed; role catalog reflects effective configuration; action-level validation rejects unknown or inapplicable fields |
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

### 2.5 工具裁剪（Pi 支持白/黑名单，Claude 仅黑名单）

角色 JSON 可带一个可选字段，直通 Pi 原生开关：

```jsonc
{ "cli": "pi", "tools": { "allow": ["read", "bash"], "deny": ["mcp__*"] } }
```

- `allow` → `--tools <逗号拼接>`；`deny` → `--exclude-tools <逗号拼接>`；两者可选，**至少要有一个非空**。
- 校验：只接受 `allow`/`deny` 两个键；数组元素必须是**无首尾空格的非空字符串**；空数组=显式报错（`--tools ""` 会打开全部工具，不能当作"不裁剪"）。
- **仅 Pi**：
  - `cli: "codex"` 带该字段 → 创建时**显式拒绝**：Codex 实测（`--help`/`exec --help`/`mcp --help`，且 `-c tools.*` 不被 `--strict-config` 校验）**没有**工具白/黑名单，接受字段会静默保留全部工具。
  - `cli: "claude"` 支持 `tools.deny`（→ `--disallowedTools`），**不支持 `tools.allow`**：真机实测 `--allowedTools Read` 之后工具清单仍是全部 24 个，说明它是“预批准”而不是“只允许”；按它实现会让角色保留全部工具，因此在创建时显式拒绝并说明。
  - claude 的 deny 会与 §2.8 的默认“禁止再派”**合并成一个 flag**（`--disallowedTools Bash,Agent`），因为该参数是可变长的，重复下发有吞参风险。
- 生效范围：写入实例 `spec.json`，随该实例每次原生启动/恢复生效（与 `defaultModeQuestions` 同样"创建时固化"）；改角色只影响新实例。
- **不做**：MCP 集合限制、技能预加载/禁用、以及 Codex `agents.enabled` 一类"限制再派"的运行时开关 —— 这三项按 oracle 要求分别裁决，本片不含。
- 角色摘要（工具描述里的 compact catalog）不重复该字段，避免每轮字节膨胀；字段只在 role JSON 与 spec 中可见。

### 2.6 技能开关与白名单（仅 Pi 角色）

角色 JSON 的 `skills` 接受三种形态：`false`（不加载任何技能）、`true`/省略（继承默认发现）、或**路径数组**（只加载点名的那些）。

- `skills: false` → `--no-skills`；`skills: true` → **不传任何 flag**（与省略等价，风格与 `defaultModeQuestions` 一致）。
- **仅 Pi**：`cli: "codex"`/`"claude"` 带该字段 → 创建时**显式拒绝**（"Codex 与 Claude 没有技能开关，角色会静默保留全部技能"）。依据：`codex 0.162.1` 帮助里无技能通道；`claude 2.1.296` 帮助里也只有 `--append-system-prompt`/`--settings`/`--plugin-dir`，无技能开关（其技能经 `/skill-name` 解析）。
- **形态校验**：只接受布尔或非空的字符串数组；`"false"`、`0`、`{}`、数组内非字符串或带首尾空格的元素 → 显式报错，不做隐式转换。
- 与 §2.5 的 `tools` 可同时存在，互不影响（`--tools … --no-skills` 并列下发）。
- **路径列表（白名单）**：`skills: ["<path>", …]` 表示**只加载这些** —— 实现为 `--no-skills` + 每个路径一个 `--skill`。空数组被拒：它看着像一份配置，实际含义是"不发现也不加载"，与本字段的另外两种形态语义重叠，应按需求显式写 `false`。
- **路径解析**：路径**原样透传**给 pi，不由本扩展改写或校验其存在性：相对路径按子代理的 cwd 解析，绝对路径按给定值使用。因此相对路径的可移植性取决于调用方，写错会表现为"该技能没加载"而不会报错——这是本设计的已知代价，换取不新造解析基准。
- **成本**：默认（省略）会加载所有被发现的技能；`false` 一个都不加载；路径列表只加载点名的那些。三者按需选择，本扩展不替调用方猜测。
- 生效范围同 §2.5：写入 `spec.json`，随该实例每次启动/恢复生效；改角色只影响新实例。

### 2.7 MCP 开关（仅 Pi 角色，H6 第三片）

角色 JSON 可带 `mcp: false`，子进程加 `--no-mcp`：不连接任何 MCP 服务器、不提供 MCP 工具。

- `mcp: false` → 不连接；`mcp: true` → **不传任何 flag**（与省略等价）。
- **仅 Pi**：`cli: "codex"`/`"claude"` 带该字段 → 创建时**显式拒绝**（"Codex 与 Claude 没有 MCP 开关，角色会静默保留全部服务器"）。
- 非布尔值 → 显式报错。
- 与 §2.5 `tools`、§2.6 `skills` 三者互不影响，按 `--tools … --no-skills --no-mcp` 顺序并列下发。
- **不做 MCP 服务器级白名单**：pi 只有"全禁"（`--no-mcp`），没有"只允许某几个"的 flag；Codex 0.162.1 的 `-c mcp_servers.*` 在本机探针中被 `--strict-config` 接受（该记录不随包分发），但**运行效果未验证**，因此本片不接。
- **真机验收**（2026-10-17，本机 pi 1.3.0 + 一个自建 stdio MCP 服务器作探针）：不带 `--no-mcp` 时该服务器**被启动**（探针写下了启动记录）；带 `--no-mcp` 时**未启动**；再加 `--no-tools` 亦未启动。结论限定为"服务器未连接"，**未**验证 MCP 工具在工具列表中的可见性。
- 生效范围同前：写入 `spec.json`，随该实例每次启动/恢复生效；改角色只影响新实例。

### 2.8 默认禁止再派（`allowSubagents`，三后端）

**默认行为**：子代理**不能再派子代理**。只有角色显式写 `allowSubagents: true` 才放行。

```jsonc
{ "cli": "codex", "allowSubagents": true }
```

- 省略或 `false` = 禁止；`true` = 允许。非布尔 → 显式报错。
- **三个后端都能兑现**（因此不像 `tools`/`skills`/`mcp` 那样对某后端拒绝）：

| 后端 | 下发 | 证据 |
| --- | --- | --- |
| pi | `--exclude-tools subagent`（与角色自己的 `deny` 合并为一个列表，不另起 flag） | `pi --help`；denylist 作用于所有工具 |
| codex | `-c agents.enabled=false` | 真机工具清单对比：六个 `collaboration.*` 工具全部消失（**主要依据**）；同 prompt 下模型自报也从 `SPAWN-AVAILABLE` 转为 `SPAWN-UNAVAILABLE`（**仅作旁证**，自报不作为独立证据） |
| claude | `--disallowedTools Agent` | 真机：`Agent` 工具从清单消失（prompt 必须走 stdin，否则会被当成工具名） |

- **例外**：pi 角色若在 `tools.allow` 里显式写了 `subagent`，视为显式允许（不再追加拒绝）；若 `tools.deny` 已有 `subagent`，不重复追加。
- **为什么默认禁止**：父会话的容量上限（§2.3）只管本扩展创建的 runtime，孙代理不经过它；允许再派等于给出一条绕过容量边界的放大路径。
- 生效范围同前：写入 `spec.json`，随实例每次启动/恢复生效；改角色只影响新实例。
- **未覆盖**：本字段只约束"该子代理能不能再派"，不约束"孙代理的数量"（若显式允许，放大仍可能发生）。
