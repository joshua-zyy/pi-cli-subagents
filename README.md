# pi-cli-subagents

A lightweight Pi extension for delegating work to real, reusable Pi CLI sessions. The parent agent chooses what to delegate; the extension manages execution and lifecycle, and a bundled skill guides delegation.

**Status: work in progress.** The Pi-to-Pi collaboration loop has been exercised, but that is not a claim that every lifecycle and terminal interaction is production-ready.

## Scope

- Dispatch independent Pi CLI sessions asynchronously, send further instructions, inspect instances, stop work, and receive reports.
- Preserve the agent ID and native session across turns. Finished CLI processes may exit; later instructions resume the original session, never a silent replacement.
- Keep accepted child work running when the parent Pi exits. Results are saved and replayed when the original persistent parent session returns.
- Review in a separate conversation, not an automatically created worktree. The parent coordinates writes in the shared working directory.
- Inherit CLI model and permission configuration unless a role overrides the model. Report unresolved interactions instead of silently approving them.

The first version targets **Pi → Pi**. It does not introduce a workflow DSL, remote service, web dashboard, automatic worktrees, nested delegation, or token budgeting. Codex and Claude adapters are not implemented.

## Development and local loading

Requires Node.js >=22.19 and an installed, configured Pi CLI.

```bash
npm ci
npm test

# From the project you want the agents to work in:
pi --extension /absolute/path/to/pi-cli-subagents/dist/index.js \
   --skill /absolute/path/to/pi-cli-subagents/skills/delegate-cli-agents
```

These command-line flags do not modify global settings. For project-level loading, run `pi install --local /absolute/path/to/pi-cli-subagents` from the target project and review its trust prompt yourself. This writes `.pi/settings.json`; relative package paths resolve from that settings file. Rebuild and reload Pi after changing the extension.

`dist/` is generated locally and ignored by Git. `prepack` builds it for packaging. Disposable demonstration tasks, raw sessions, and local acceptance drivers are not shipped.

## Agent tools

| Tool | Purpose |
| --- | --- |
| `spawn_agent` | Start a `worker`, `reviewer`, or custom role in a chosen working directory. |
| `send_input` | Steer a running child, queue a `followUp`, or resume a finished child's original session. |
| `list_agents` | List this parent's instances, roles, results, errors, and pending questions. |
| `close_agent` | Stop active work without deleting the session or its history. |

The parent must have a persistent session; `--no-session` cannot own subagents. Prompt acceptance is not completion. The final report records whether the run succeeded, failed, stopped, or needs a response.

## Terminal UI

The status widget above the editor shows role, phase, recent tool activity, and elapsed time. Waiting requests take priority. Active instances have a second activity line; finished instances collapse to one line, linger for 30 seconds, and then disappear. No widget space is reserved when there is nothing to show.

### `/agents`

Use **Up/Down** to select an instance and **Enter** to open its summary. The summary contains the task, latest activity, result or error, native session, log path, and pending request.

| Key in the summary | Action |
| --- | --- |
| `v` | Open the live conversation viewer. |
| `s` | Message an active child or resume a finished child's original session. |
| `x` | Stop an active child, after confirmation. |
| `r` | Answer a pending interaction as the human user. |
| `Esc` / `Left` | Return to the list. |
| `q` | Close the panel. |

The conversation viewer reads existing event logs incrementally. It shows user and assistant text, tool arguments, partial and final tool output, and errors across the instance's runs. It supports both cumulative and delta-only Pi RPC streaming formats. It stays open when the child finishes. This is an execution transcript, not a viewer for hidden reasoning or binary attachments.

- New output is followed automatically. **Up/Down** or **Page Up/Page Down** scroll; scrolling up pauses following.
- **Home** goes to the oldest retained entry; **End** returns to live following.
- **s** messages/resumes the selected instance; **x** requests a confirmed stop. **Esc/q** returns to the list.
- Viewing and closing the UI never starts, stops, or approves a child by itself.

History is bounded to the latest 300 entries, with up to 24,000 characters per text/input and a 4 MiB limit per raw JSONL record. Clipping and malformed records are reported; original logs remain available. Large histories load progressively. This is not a byte-for-byte replacement for the native session or raw event log.

Panels use temporary overlays, not a replacement editor. They are TUI-only; RPC and non-interactive modes keep the four tools. Actions can take time: an active send has a 35-second control timeout, a resume can take about 60 seconds including prior process release, and stopping can take 30 seconds. Acceptance timeouts require inspection, not blind retries.

## Custom roles

Built-ins are `worker` and `reviewer`. Override or add roles in:

- User: `~/.pi/agent/cli-subagents.roles.json`
- Trusted project: `.pi/cli-subagents.roles.json`

Project roles replace user roles with the same name; user roles replace built-ins. Replacements are whole role definitions, not field-by-field merges. `description` and `instructions` are required. `provider`, `model`, and `thinking` are optional. Allowed thinking values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (the selected model must support the value).

```json
{
  "tester": {
    "description": "Independently verify the implementation",
    "instructions": "Inspect the assigned changes and report reproducible issues. Do not modify source files."
  }
}
```

Role instructions are not a security sandbox. Per-role tool/skill restrictions are not implemented.

## Interactions and local data

Native Pi has no default permission-approval workflow. Other extensions can request interaction. Those requests enter `waiting`; only an explicitly initiated human response is supported through `/agent-reply <agentId> <questionId>` or the panel. The model has no approval tool. This is a policy/interface boundary, **not OS isolation**: processes under the same user can access local control files.

Sessions, reports, and event logs live beside the parent session in `<parent-session-file>.subagents/`. They can contain sensitive task data; do not publish them. Control credentials are not included in tool results. Closing an instance does not delete these files.

If a worker is unreachable or an ownership lock remains, the extension refuses duplicate execution and requires inspection. It does not automatically reclaim stale locks or recover a crashed execution owner.

## Verification and limits

`npm test` builds the extension and runs deterministic tests without model calls. Tests cover protocol framing, lifecycle and original-session resume, role trust, report receipts, UI rendering, keyboard actions, transcript streaming, and cleanup. `npm run check` checks TypeScript.

`node test/real-smoke.mjs` is an explicit opt-in real-model test; it normally makes two small calls and writes only to `.test-output/`. Prior real Pi RPC acceptance exercised implementation → independent review → original implementer continuation, parent exit/reconnect, offline report replay, and deduplication. Temporary tasks and raw acceptance artifacts remain local.

Automated component tests are not full terminal acceptance. A no-model Windows ConPTY smoke test also loaded the actual Pi TUI in regular and fullscreen modes: opening the panel/viewer, rendering tool arguments and live output, resizing, scrolling, closing and exiting all passed. Its child was a deterministic RPC fixture, not another model call. Real TUI permission dialogs, parent TUI exit/replay, every terminal/key protocol and theme, and execution-owner crash recovery are not comprehensively verified. TUI approval is an optional compatibility path, not a blocker for the core Pi-to-Pi collaboration test. Safety-guard false positives and parent-delegated approval policy remain separate work.

## References

[Paseo](https://github.com/getpaseo/paseo) informs the lifecycle and orchestration goals. [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) informs the compact status and conversation-viewer interaction. This extension keeps its own Pi CLI process ownership and persistence model rather than importing their workflow systems.
