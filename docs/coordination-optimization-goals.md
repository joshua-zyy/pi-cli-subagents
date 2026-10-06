# Pi Agents: CLI Subagent Capabilities and Session Management Goals

Status: the product direction is confirmed. The current phase focuses only on CLI subagent dispatch and management by the parent Pi agent; `@role` dispatch is deferred. The four tools, role catalog and follow-up notifications have passed local implementation checks; see the [interface design](subagent-tool-contract.md). The remaining goals in this document are neither claims of completed functionality nor authorization for further implementation.

This document replaces the earlier "parent-agent coordination optimization" proposal. It retains the original filename to preserve existing links. Since the rewrite, three tool-management increments have been implemented under separate authorization; real dispatch and model calls still require separate authorization.

## 1. Product positioning

**Bring a Paseo Agents-like experience to an installable Pi extension, allowing users and their parent Pi agents to directly use other CLIs as subagents.**

This is a CLI subagent toolset and session-management interface, not an orchestrator that decides how users divide their work. It provides reliable operations, state and results; users define their workflows through their own AGENTS.md, prompts and role configuration.

The long-term vision has two entry points sharing the same instance-management capabilities. For now, only tool-based dispatch is in scope; the existing user management interface remains, without a new @-dispatch entry point:

```text
Parent agent calls tools --+
                          +-- CLI subagent instance -> state, interactions, results -> originating Pi parent session
User directly uses @role -+
```

Paseo is the primary reference for the experience and session management, not a requirement to adopt its services or port the entire platform. The project does not follow the OMO / OMO-slim direction of scheduling and orchestrating work for the user.

## 2. What the extension owns and what it does not

| Extension responsibility | User and parent-agent decision |
|---|---|
| Launch CLIs, preserve native session identity, expose actual capability limits | Whether to delegate, how to split tasks, which role to choose |
| Send messages to a specific instance and explain receipt and execution semantics | Whether to reuse an instance and what context to provide |
| Present instance state, conversations, results and pending requests | How to evaluate work and whether independent review is needed |
| Stop, continue and recover without silently replacing the original session | When to stop, request rework or change assignments |
| Load user-configured roles and provide default examples | Role names, responsibilities, models, providers and prompts |

The extension does not set default review triggers, prescribe a worker → reviewer pipeline or a default agent count, assign work by model price or tier, or automatically upgrade models.

Built-in roles are replaceable defaults, not a hardcoded job hierarchy. Users should be able to customize, override and replace them; tools and UI must not depend on specific names such as explore, worker or reviewer.

Keep interface safety contracts separate from workflow policies. For example, continuing a session must not silently create another one, and reading a result must not start work: these are tool contracts. Whether to involve a reviewer or prefer a particular existing instance belongs to the user's workflow. Natural-language role descriptions must not be advertised as sandbox-enforced permissions.

## 3. Initial experience scope

| Capability | Expected user experience |
|---|---|
| Instance list | View instances created by this parent session in Pi, distinguishing roles, instances, current tasks and states |
| Conversations and results | Open child conversations and locate original content and historical results, not just summaries |
| Direct operations | Message instances, handle approval requests, stop, continue or recover without relaying everything through the parent agent |
| Tool-based dispatch | The parent agent sees available role descriptions, launches instances through tools, and receives accurate directory and startup receipts |
| Return to the parent session | Success, failure and actionable blockers notify the original parent session; notifications queue while it is busy without interrupting its current operation |

The initial scope excludes remote connections, mobile clients, cross-device services, scheduled jobs and takeover by another parent session. Keep existing Pi, Codex and Claude support; stabilize Pi → Pi first, then verify the actual differences in the other CLIs. Rewriting all three adapters at once is not required.

The parent agent now uses four tools: subagent, subagent_query, subagent_reply and subagent_workspace. Preserve isolated worktrees, reuse across instances and safe integration; do not remove capabilities merely to reduce the tool count. See the interface design for parameters, failure semantics and compatibility policy.

## 4. Roles, instances and runs

| Concept | Meaning |
|---|---|
| Role | A user-configured launch template, including the selected CLI, model settings and role prompt |
| Instance | A child session that can be interacted with after creation, with stable identity and native session information |
| Run / current task | One round of work accepted by an instance, with an independently addressable result; an instance can have multiple runs |
| Owning parent session | The Pi session that creates and manages the instance and owns its user-action records and task notifications |

The UI must not conflate multiple instances of the same role, nor replace references to old tasks with the latest run's result. Changing role configuration must not imply that existing instances automatically adopted it. The exact point at which changes take effect must be checked during technical design and clearly presented.

## 5. Direct user @role semantics (deferred concept, outside the current phase)

The following preserves earlier discussions. Input ambiguity, concurrency and cost must be reassessed before this direction resumes; these are not current implementation requirements. Example interaction:

```text
@research Check this library's compatibility with the current version
```

1. **Direct dispatch.** The extension passes the user's task to the selected role without first asking the parent agent to decide whether to delegate, rewrite the task or choose another role. Normal role configuration still applies.
2. **New instance by default.** @role creates a new instance rather than automatically selecting the most recent or familiar one. Continuing work requires explicitly selecting an existing instance with a visible target.
3. **Parent awareness.** The parent session records which task the user dispatched to which instance and the actual startup result. This is not a second request for the parent agent to execute the same task.
4. **Current directory by default.** Use the current Pi working directory and show the target directory during dispatch. When isolation is needed, the user explicitly selects an existing workspace or creates an isolated one; no worktree is created automatically.
5. **No implicit fallback.** Missing roles, invalid configuration and unavailable CLIs produce explicit errors. Do not switch roles or CLIs, or silently forward the task to the parent agent instead.

Ordinary messages without a role still go to the parent agent. @-dispatch does not expand authorization for files, spending or other operations.

Startup receipts must distinguish "not started" from "may have started but confirmation failed." The latter should provide any known identity or diagnostic entry point, not encourage a blind retry that duplicates work.

## 6. Shared instances across both entry points

The parent agent can inspect and operate user-created instances through existing tools; users can also take over parent-agent-created instances through the UI. Both entry points share identity, ownership, permission and lifecycle checks rather than maintaining mutually invisible lists.

After the user directly sends a message, stops an instance or answers a request, the parent session should receive an action record so the parent agent does not act on stale state. Records must identify their source: do not disguise user actions as parent-agent tool calls or attribute runtime-generated explanations to the child.

Honor explicit user instructions for the parent agent not to intervene, without automatically introducing a new permission-isolation system. Serializing simultaneous operations, rejecting conflicts and presenting results are technical contracts to verify before implementation; neither entry point may bypass the other's state checks.

## 7. Notifications and result delivery

| Situation | Target behavior |
|---|---|
| Normal run completion | Notify the originating parent session with the original task, instance and run identities, result and full-text entry point |
| Failure or abnormal termination | Report the actual outcome and available diagnostics; do not present an exit or empty result as success |
| Approval or another actionable blocker | Make it visible in the UI and notify the parent session; respect the original authorization boundaries, with no parent-agent approval of humanOnly requests |
| Ordinary streamed output | Update the instance view without notifying or waking the parent agent for each fragment |
| Busy parent agent | Queue notifications for an appropriate follow-up opportunity without interrupting the current operation |

Completion notifications should give the parent agent a chance to respond automatically, without requiring the user to say "check the result." This is a return triggered by task events, not periodic prompting. Whether the parent then informs the user, synthesizes results or continues working depends on user instructions; the extension does not prescribe the next step.

Preserve sent content, original reports and raw logs. Folding, summaries and pagination change presentation and access, not the evidence. Result entry points bind an instance ID and run ID; later runs must not change the meaning of old references.

Distinguish message receipt, task execution, the end of a CLI run, result delivery and acceptance of the business outcome. The extension presents states it can prove; it neither performs semantic acceptance nor requires a fixed VERDICT / EVIDENCE / UNVERIFIED format to support the user's workflow.

Follow-up routing, redelivery under the original run after queue loss, and deduplication through persisted receipts have been checked locally. Broader failures, including asynchronous delivery failure, still need verification; exactly-once delivery is not claimed. Notification failures must never automatically rerun tasks.

## 8. Lifecycle, recovery and permission boundaries

1. **Original-session recovery.** Resuming the original Pi parent session restores access to its instances and undelivered results. A new Pi session in the same directory does not automatically take over old instances. Cross-session transfer is outside the initial scope.
2. **Recoverable persisted sessions, not permanent processes.** Continuation and recovery target the original CLI session identity and saved history. They do not guarantee that the same process, memory state, background shell, watcher or build job survives between runs. Recovery failure must be explicit, without silently creating a replacement. Releasing execution resources, ending a run and deleting history are different operations.
3. **Stopping is not rollback.** Stopping must not imply that file changes were undone. If the old execution's termination is uncertain, do not claim that resuming or starting a replacement writer is safe.
4. **Explicit capability differences.** Reject unsupported message modes or recovery operations with an explanation. A receipt must not claim that the target has read or executed the message. Tools and UI entry points follow the same constraints.
5. **No permission expansion.** Neither direct @-dispatch nor parent-agent tool calls bypass host, CLI or existing workspace safety checks. The extension does not approve extra permissions on the user's behalf, automatically rerun tasks, change models or implement fallback plans.

Retain notifications while the original parent session is closed and deliver them when it resumes, rather than secretly starting a new parent session just to send them. Whether a child CLI can continue after its parent process exits must be verified against its actual capabilities and shown clearly, not hidden behind a universal promise. "No permanent-process guarantee" also does not permit treating an unreachable active execution as completed or safe to rerun: preserve identity, check whether the old execution still owns resources, and report uncertainty honestly.

## 9. Usage guidance and existing constraints

The bundled skill and tool descriptions should explain capabilities: entry points, parameters, message modes, state meanings, result reading, approvals and recovery. They should not set task assignments, reuse priorities, review gates or default pipelines.

Source review corrected an earlier assumption: independent review requirements for managed workspaces primarily lived in tool descriptions and the skill. WorkspaceStore.apply() had no hard gate that read reviewer results or checked PASS. The four-tool migration removed those extension-imposed review policies while preserving ownership, occupation, baseline, conflict and uncertain-operation checks. Users' own review requirements are unaffected.

Role selection and task content remain decisions for the user or parent agent. The extension does not attempt to use a natural-language semantic interceptor to decide whether a role should perform a task.

## 10. Observable acceptance scenarios

These are product acceptance goals, not claims of current implementation or verification. The @ portions of A2 and A3 are deferred. A1 and A4 currently cover only tools and the existing management UI, without a new user dispatch entry point. See the interface design for the specific four-tool gates and verified scope.

| ID | Scenario | Passing condition |
|---|---|---|
| A1 | User configures a non-built-in role | The list and @ entry point recognize actual configuration without relying on built-in names; defaults can be overridden or replaced |
| A2 | Dispatch through @role | The user's task goes directly to the selected role; the parent is informed without dispatching it again |
| A3 | Multiple instances of the same role already exist | Another @role explicitly creates a new instance; explicitly selected continuation preserves identity without guessing the target |
| A4 | User takes over a parent-agent-created instance, or vice versa | Both see the same instance and state; direct actions record their source and cannot bypass ownership or permissions |
| A5 | Default directory and explicit isolation | The current Pi working directory is the visible default; no automatic worktree creation; an explicitly selected directory is used accurately |
| A6 | Child finishes while the parent agent is idle or busy | The original parent receives the matching task result and can respond; busy execution is not interrupted; no predefined follow-up workflow is triggered |
| A7 | Task fails or awaits human approval | User and parent see the actual failure/blocker; humanOnly requests are not approved on the user's behalf |
| A8 | Startup fails or its confirmation is lost | Distinguish not-started from uncertain state; no automatic role/CLI switch or duplicate launch |
| A9 | Continuation after stopping, or recovery failure | Identity remains stable; stopping does not masquerade as rollback; failure does not silently create a replacement instance |
| A10 | Resume the original Pi session versus create a new session in the same directory | The original session finds its instances and undelivered results; a new session does not automatically take over |
| A11 | Long reports, folding and multiple continuation runs | Original content remains readable and old run references stay stable, without substitution by the latest result |
| A12 | User chooses their own division of work and reporting style | No mandatory role order, review trigger or report format; technical capability limits remain explicit and enforced |

Parallel task count, the presence of independent review, and whether the parent proactively decomposes tasks are not success metrics for the extension. Evaluate clarity of direct operations, accurate identities and messages, trustworthy state, and delivery to the correct parent session.

## 11. Approach for the next phase

After the gap review, the four tools, role catalog and notification queue were implemented in three separate increments. Their verified scope is documented in the interface design. Continue with the stages below; confirming product boundaries does not automatically expand the feature scope.

| Stage | Work | Deliverables and limits |
|---|---|---|
| Gap review | Compare the current scope against tools, management UI, role configuration and notifications; distinguish workflow wording from technical checks | Identify existing, missing, conflicting and unverified behavior without rebuilding existing capabilities |
| Technical design | Four-tool parameters, role-catalog refresh, notification queue, CLI capabilities, workspaces and recovery | Read current host documentation and source; defer @-related technical design |
| Independent implementation increments | Split by independently verifiable user capabilities rather than refactoring the entire manager at once | Implement after user approval; test, review and verify each increment before committing |
| Real experience acceptance | After separate authorization to resume dispatch and real calls, check Pi → Pi, then Codex / Claude | Local fake-CLI checks do not count as real-model or real-CLI verification |

## 12. References and evidence scope

The main reference is Paseo's Agents session management, not its entire product architecture. The previously reviewed version was pinned to `cc8fe41e2828a34d4d9706c0b8353c0e91987a25`:

- [Agent lifecycle documentation](https://github.com/getpaseo/paseo/blob/cc8fe41e2828a34d4d9706c0b8353c0e91987a25/docs/agent-lifecycle.md): persisted identity is separate from runtime residency; closing and deleting are different operations.
- [AgentManager implementation](https://github.com/getpaseo/paseo/blob/cc8fe41e2828a34d4d9706c0b8353c0e91987a25/packages/server/src/server/agent/agent-manager.ts): saved handles support recovery; the original runtime's occupation is not released before closing succeeds.

These are source and documentation references, not evidence of running Paseo end to end in this round. The @role, dual-entry-point and notification semantics here come from user confirmation; this document does not claim that Paseo has the same input method. Earlier OMO / OMO-slim orchestration research is no longer a basis for product design. If code is to be ported later, check the selected version's license separately.

**Next step: reload the extension to inspect the four tools and role catalog; once real dispatch is authorized again, evaluate the Pi → Pi collaboration experience. Real calls require separate authorization.**
