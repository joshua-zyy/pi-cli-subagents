# CLI Subagent Four-Tool Interface Design

Status: the four tools, role catalog and follow-up notifications were implemented in separate increments, with `b406426` as the code baseline. Local verification passed; the real-model and real-CLI collaboration experience has not yet been accepted.

The current scope covers only CLI subagent dispatch and management by the parent Pi agent. `@role` and a new direct user dispatch entry point are deferred; the existing user management UI remains. This document refines the product goals and does not authorize further code changes, real dispatch or model calls.

## 1. Design conclusion

Use four tools with separate responsibilities, exposing the role catalog directly in the dispatch tool's description. Preserve native sessions, historical results and workspace identity; do not reduce the tool count by removing capabilities.

| New tool | Operations | Existing capability source |
|---|---|---|
| `subagent` | `start` / `send` / `stop` | `spawn_agent` / `send_input` / `close_agent` |
| `subagent_query` | `list` / `get` / `result` | The three reading modes of `list_agents` |
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
| `stop` | `id` | None | Stop active execution while retaining the native session and history; do not delete files or roll back changes |

`start` defaults to the current Pi working directory; when workspace is specified, resolve its actual path from the record. The role must exist in the current effective configuration. Resolve CLI, provider and model from role configuration; do not expose per-run model-routing parameters. task/message must be non-empty.

`send.mode` remains `steer | followUp`, defaulting to steer. It controls how the child receives instructions, not how result notifications are delivered to the parent agent.

| Target state / CLI | `send` behavior |
|---|---|
| Running Pi | Deliver using the selected steer/followUp mode; receipt does not imply execution |
| Running Codex | Use the supported steer path; explicitly reject followUp |
| Running Claude | Running delivery is currently unsupported and explicitly rejected; wait for the run to end before continuing |
| Unresolved interaction request | Direct the caller to `subagent_reply` or the user interaction entry point; ordinary messages are not approvals |
| Finished, with a recoverable original session | Wait for the old execution to release resources, then start a new run in the same instance |
| Missing session, unclear occupation or uncertain state | Reject with diagnostic guidance; do not silently create a replacement |

These CLI capabilities describe the current implementation, not a promise that every upstream version will behave identically forever.

Recovery covers native session identity and saved history, not permanent residency of the child CLI process or background jobs. Sending after completion may restart the CLI and load the original session; it does not mean the old background shell, watcher or memory state remains. An unrecoverable original session must fail explicitly. If an active execution becomes unreachable, check occupation and state; recovery must not launch a duplicate writer whose predecessor's state is unknown.

`baseline: keep | sync` and `includeUncommitted: { reason }` apply only to managed workspaces. Continuing an instance after integration or a baseline change requires an explicit baseline choice. Sync cannot run on an active instance or overwrite unintegrated changes. The reason records the caller's explanation; it is not proof that the extension has established user authorization.

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

The existing `AgentState.accepted` describes receipt of the run's initial task, not an independent receipt for every send. An existing true value cannot prove delivery of a new message. A send response is based on the control request's actual result; do not add read/executed guarantees unsupported by the native CLI.

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

Keep the workspace inventory in `list` so reusable workspaces and their occupation can be discovered without a fifth listing tool. `get` may include necessary information about the instance's associated workspace; do not add cross-parent-session scanning.

The result action retains the current pagination contract: offset defaults to 0; limit defaults to and cannot exceed 6000 UTF-16 code units. Return `agentId`, `runId`, `status`, `time`, `error`, `offset`, `totalLength`, `nextOffset` and `text`. Keep id/runId fixed and follow nextOffset until null.

Reject missing, corrupt, cross-instance or cross-parent-session results. A missing original report cannot be replaced with the current latest result. Reading must not start, wake or stop an instance, or approve an operation. Neither a result preview nor terminal state proves acceptance of the business outcome.

## 4. `subagent_reply`: answer a specific request

Retain the parameters: `id`, `questionId` and `reason` are required; supply exactly one of `confirmed`, `value` or `cancelled: true`, matching the request type.

| Request type | Answer |
|---|---|
| confirm | A confirmed boolean, or cancellation |
| select | The value of a currently valid option, or cancellation |
| input/editor | Text in value, or cancellation |

The request must belong to the current parent session and specified instance and must not be resolved or expired. The tool implementation sets the actor to parent; the model cannot supply `actor: human`. humanOnly approvals remain with the human entry point; denial/cancellation may still be handled where the request allows it.

Return the current state and actual response-receipt result, without claiming that the approved operation completed. Preserve existing local decision records. Ordinary send operations cannot bypass these checks.

Keep this tool separate so approval responses remain distinguishable from ordinary lifecycle operations; do not turn it into an automatic approval policy.

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

Results and actionable blockers use the existing automatic notification channel; the child does not need a separate reporting tool. Notifications bind the original parent session, instance and run and provide the new result query entry point. Long originals use a preview plus full-text pagination, without deleting evidence.

Notification semantics: an idle parent may be triggered to handle the event; a busy parent receives queued follow-ups, not steering messages. `deliverReports` now uses followUp; this is distinct from `subagent.send.mode`. The queue is not a persisted receipt. Resuming the original parent can redeliver unrecorded notifications, while recorded notifications are deduplicated by ID. This is not an exactly-once guarantee under every failure mode.

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
| Notifications and compatibility | Delivery to the original parent; busy follow-up queuing; recovery redelivery; old instances and runs remain readable; historical notifications are unchanged |

Issues such as roles being overridable but not currently removable, uncertain startup receipts, and corrupt reports affecting a notification batch are separate from merging tools. Verify them with counterexamples and separate increments rather than packing every reliability fix into a tool rename.

During the four-tool migration, serialized name/description/parameters JSON fell from 6,279 to 5,147 bytes. That measurement preceded the dynamic role catalog and is not a final token count. Having 4 tools rather than 7 does not by itself mean correct usage is easier. Continue to prioritize local tests and fake CLIs; real calls require separate authorization.

## 8. Current evidence and unverified items

The contracts were checked against `src/index.ts`, `src/types.ts`, `src/manager.ts`, `src/notifier.ts`, `src/worker.ts`, `src/roles.ts`, `src/workspace.ts` and the existing skill. This draft introduced no runtime types, state tables, databases or queue implementations.

Implementation commits: `4b46bdc` (four-tool migration), `29de2e4` (effective role catalog) and `b406426` (follow-up notifications). At that baseline, all 385/385 local tests and typecheck/build passed, as did tool-refresh probes using the project's dependency and the installed Pi loader. Notification tests use actual SDK routing methods with controlled execution stubs, covering busy queuing, original-run redelivery after queue loss and persisted-receipt deduplication; this is not acceptance of the complete model loop.

No real models, real CLI collaboration or independent agent review were run. @-dispatch, new multi-entry-point behavior and real-endpoint compatibility remain unverified.

Next step: reload the extension to inspect the tools and role catalog; real collaboration acceptance requires separate authorization.
