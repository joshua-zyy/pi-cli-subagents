# pi-cli-subagents

[Chinese README](README.zh-CN.md)

Delegate work from Pi to **reusable Pi, Codex, and Claude Code sessions**. Run independent tasks concurrently, receive completion reports automatically, and continue with the same agent for follow-up work. Optional Git worktrees keep parallel edits separate.

## Quick start

Requires Node.js **>=22.19** and a configured Pi CLI. Install and authenticate Codex or Claude Code separately if you want to use them.

```bash
# In this extension's directory
npm ci
npm run build

# In the project where you want to use it
pi install --local /absolute/path/to/pi-cli-subagents
pi
```

The local install adds the extension and bundled skill to `.pi/settings.json`; review the project trust prompt yourself. For a one-off run without changing settings:

```bash
pi --extension /absolute/path/to/pi-cli-subagents/dist/index.js \
   --skill /absolute/path/to/pi-cli-subagents/skills/delegate-cli-agents
```

Ask Pi, for example:

> Have the configured worker investigate and fix this test in an isolated worktree, and report the result.

Roles, task decomposition and review policy are yours to configure; the extension does not impose an agent workflow.

Use a persistent parent session, **not `--no-session`**. Reports arrive automatically; do not poll for completion. A running child can continue after the parent exits; reopen the **original parent session** to receive its pending reports.

## Roles and models

All four built-in roles use Pi: `explore` investigates, `worker` implements and verifies, `reviewer` independently reviews, and `oracle` gives a second opinion. Read-only role instructions are **not a permission sandbox**.

Open **`/cli-agents-setting`** to choose each role's CLI and model. **Tab** switches user/project scope, **Enter** edits, **s** saves, and **Esc** goes back one level or closes the role list (asking before discarding an unsaved draft). Selected roles, fields, and choices stay visible in short panels. Changes apply to the next spawn.

You can also edit role files directly:

- User: `~/.pi/agent/cli-subagents.roles.json`
- Trusted project: `.pi/cli-subagents.roles.json`

Precedence is **project > user > built-in**. Each entry replaces the whole role; `description` and `instructions` are required. For example, move only the reviewer to Codex (replace the model placeholder):

```json
{
  "reviewer": {
    "cli": "codex",
    "description": "Review changes independently",
    "instructions": "Inspect the assigned changes without editing files. Report issues with evidence and state what you verified.",
    "model": "YOUR_AVAILABLE_CODEX_MODEL",
    "effort": "high",
    "mode": "read-only"
  }
}
```

| CLI | Model settings | Permission setting (`mode`) |
| --- | --- | --- |
| Pi | `provider`, `model`, `thinking`; omitted values follow the parent at launch | Not supported |
| Codex | Required `model`; optional `effort` supported by that model | `read-only`, `workspace-write`, `full-access` |
| Claude Code | Optional `model` and `thinking` (passed as `--effort`) | `manual`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions` |

These are per-launch settings, not changes to the CLIs' global configuration. Codex/Claude use native defaults for omitted optional settings. **Do not assume approval prompts will appear:** `dontAsk`, `bypassPermissions`, and `full-access` suppress them, with different denial/permission behavior. Leave `mode` unset unless you deliberately want to override the native posture.

## Monitor and continue

Open **`/agents`** or press **Ctrl+Alt+A**. Select an instance with **↑/↓**; use **Enter/v** for its live conversation, **s** to message or resume, **r** to answer a request, and **x** to stop. Closing the viewer does not stop the agent. On first open the viewer reads one bounded tail window and afterwards only follows bytes appended to it; scrolling upward (**PgUp**, **↑**) within about two screens of the loaded top prefetches an older page while preserving your reading position; **Home** triggers it directly. Upward movement requested during loading is applied when the page arrives, with same-direction requests coalesced and no accidental reverse paging. **End** supersedes pending upward movement. Each disk page keeps at most 300 entries. A separate display list retains up to 1200 entries with an 8 MiB text-and-key budget, rather than being replaced wholesale by the next disk window. Eviction prefers non-visible content opposite the navigation direction, never the entries being read. Visible content is held while paused; returning to the end publishes the latest already-read values. History still reaches the oldest records step by step and can be walked back down; **End** re-anchors at the live end. Reopening the same agent in this process reuses the paged window, so a window left on an old page stays there until you press **End**, while a replaced or truncated log drops it. Whole-log token totals appear only when the loaded window really covered every run; otherwise the header says **Stats incomplete** instead of showing a partial number. Status, scrolling, and message/stop controls remain available throughout, and event logs are never modified.

The viewer draws on [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)’ conversation-list, scroll-offset and auto-follow model, measuring current content on every navigation key. This project additionally adapts on-demand logs from independent CLIs rather than directly holding an SDK `session.messages` array.

Tools in the live viewer default to one-line summaries, including failures (marked with `✗`). **Ctrl+O** toggles all loaded tool inputs and outputs in this viewer only; it follows the host’s `app.tools.expand` binding, including remapping or disabling it. Expansion survives live updates, while **Enter** still opens the message composer. Long content remains subject to the existing reader limits and clipping notices; original logs are unchanged.

| Tool available to the parent | Purpose |
| --- | --- |
| `subagent` | `start` a configured role, `send` to an existing instance, or `stop` active work |
| `subagent_query` | `list` metadata/workspaces, `get` instance details, or read an exact run with `result` |
| `subagent_reply` | Answer one current request with an explicit reason |
| `subagent_workspace` | Explicitly `create` a managed worktree or `integrate` its pending changes |

`subagent_query({action: "list"})` returns metadata without result bodies; `{action: "get", id}` adds the current bounded preview. Final notifications include a `subagent_query({action: "result", id, runId})` link to the original result for that exact run. For longer results, keep both IDs fixed and pass the returned `nextOffset` as `offset` until it is `null` (default/max `limit: 6000` UTF-16 code units). Reading results never resumes an agent.

In the TUI, reports follow Pi’s expand/collapse state (**Ctrl+O** by default, respecting custom keybindings). Collapsed cards show a one-line instance/status summary, with failures and pending requests highlighted; expand to see the notification body and exact-run result link. Old notifications without display metadata show `status unavailable` rather than an inferred success. Only presentation changes: parent-facing content and delivery receipts remain intact. Expanded text strips ANSI/terminal controls; original records are unchanged.

Pi and Codex accept running `steer` messages; running `followUp` is Pi-only. Wait for Claude to finish before sending more instructions. Panels are TUI-only; the tools also work in RPC/non-interactive modes.

## Isolate parallel edits

Ask Pi to use **one managed workspace per independently integrable change**:

1. `subagent_workspace({action: "create"})` creates a detached worktree from committed HEAD. Dirty parent files are reported, **not inherited**; inheriting them requires inspection and explicit authorization via `includeUncommitted`.
2. Use `subagent({action: "start", role, task, workspace})`. Different workspaces may run concurrently; one workspace permits one active instance at a time and can be reused after release.
3. Use `subagent_workspace({action: "integrate", workspace})` when appropriate for your workflow. The extension checks technical safety, not whether a particular review procedure was followed.
4. To continue after integration or another instance's sync, explicitly choose `baseline: "keep"` (current workspace files) or `"sync"` (update from the parent). Sync refuses unintegrated or staged work; later integration applies only the new increment.

Integration leaves the parent's HEAD, index, and branches unchanged. Worktrees live under `<repo>.worktrees/`; dependencies and trust are not set up automatically. Shared `cwd` sessions do **not** isolate files, and worktrees do **not** isolate OS permissions.

Managed workspaces require Git with `check-attr --source` (tested on 2.50.1). Sparse checkouts, unmerged indexes, submodules, symlinks, and content filters such as Git LFS are refused. Cleanup is manual and requires authorization; inspect the worktree before removing it, and do not force removal to bypass a refusal.

## Safety and limitations

- **Approvals are single-action.** The extension does not grant session-wide or persistent permissions. Each child request carries the responses the parent agent may submit: only values whose effect this extension has established — Claude's and Codex's own one-action choices, and the audited safety-guard option set, where the parent may refuse or allow one action but never `Allow for this session` or `Always allow in this cwd`. Anything else, including a request written by an earlier version, must be answered by a human through the panel or `/agent-reply <agentId> <questionId>`; the parent may still refuse it. Approval is not proof of successful execution.
- **Conflicts are checked before integration writes**, but crashes or I/O failures can leave partial changes. Inspect retained patches, backups, and unfinished journals before retrying. Stale locks and crashed execution owners are not recovered automatically; pause external writers during snapshot/integration/sync.
- **Local records can contain sensitive source data.** Sessions, logs, snapshots, and backups live beside the parent session in `<parent-session-file>.subagents/` and are not deleted when an instance closes.
- **Compatibility has limits.** Pi is the primary end-to-end tested workflow. Codex protocol checks used CLI 0.159.2; Claude requires native Claude Code >=2.1.283 on PATH (`claude.exe` on Windows). Real-parent Pi → Codex/Claude orchestration, live TUI approval/baseline dialogs, and arbitrary crash recovery are not fully verified.

## Development

```bash
npm run check   # TypeScript check
npm test        # Build + all local tiers; no model calls
npm run test:fast
npm run test:domain
npm run test:acceptance:local
npm run test:list # List the local selection without building/running it
```

Test entries isolate user role configuration and clear the inherited child marker before imports, then run serially. For a focused domain check: `npm run test:domain -- workspace.test.mjs`. See [test tiers and verification costs](docs/testing.md) for selection rules, local-only boundaries and measured timings.

After code changes, rebuild and run `/reload` in Pi. Automated tests are not full terminal acceptance. Routine calls are documented by the tools; see the [operational reference](skills/delegate-cli-agents/SKILL.md) for approvals, results, workspaces and recovery. Historical notifications and saved sessions are not rewritten; use their original instance/run IDs with the new query tool.

Inspired by [Paseo](https://github.com/getpaseo/paseo) for lifecycle management and [pi-subagents](https://github.com/tintinweb/pi-subagents) for the status and conversation UI.
