# pi-cli-subagents

[中文文档](README.zh-CN.md)

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

> Have an explore agent locate the cause of the failing test without editing files. Then have a worker fix it and a separate reviewer inspect the changes. Reuse the original worker for any fixes, and report the verification results.

Use a persistent parent session, **not `--no-session`**. Reports arrive automatically; do not poll for completion. A running child can continue after the parent exits; reopen the **original parent session** to receive its pending reports.

## Roles and models

All four built-in roles use Pi: `explore` investigates, `worker` implements and verifies, `reviewer` independently reviews, and `oracle` gives a second opinion. Read-only role instructions are **not a permission sandbox**.

Open **`/cli-agents-setting`** to choose each role's CLI and model. **Tab** switches user/project scope, **Enter** edits, **s** saves, and **Esc** goes back. Changes apply to the next spawn.

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

Open **`/agents`** or press **Ctrl+Alt+A**. Select an instance with **↑/↓**; use **Enter/v** for its live conversation, **s** to message or resume, **r** to answer a request, and **x** to stop. Closing the viewer does not stop the agent.

| Tool available to the parent | Purpose |
| --- | --- |
| `spawn_agent` | Start a role with a task and either `cwd` or `workspace` |
| `send_input` | Continue the same instance in its original session |
| `list_agents` | Inspect instances, history, roles and pending requests; read a specific run’s result on demand, not for completion polling |
| `close_agent` | Stop active work without deleting its session |
| `create_workspace` | Create a managed Git worktree |
| `integrate_workspace` | Apply reviewed workspace changes to the parent directory |
| `respond_to_permission` | Answer one current request with an explicit reason |

`list_agents()` returns metadata without result bodies; `{id}` adds the current bounded preview. Final notifications include a `list_agents({id, runId})` link to the original result for that exact run. For longer results, keep both IDs fixed and pass the returned `nextOffset` as `offset` until it is `null` (default/max `limit: 6000` UTF-16 code units). Reading results never resumes an agent.

Pi and Codex accept running `steer` messages; running `followUp` is Pi-only. Wait for Claude to finish before sending more instructions. Panels are TUI-only; the tools also work in RPC/non-interactive modes.

## Isolate parallel edits

Ask Pi to use **one managed workspace per independently integrable change**:

1. `create_workspace({})` creates a detached worktree from committed HEAD. Dirty parent files are reported, **not inherited**; inheriting them requires inspection and explicit authorization via `includeUncommitted`.
2. Start a worker with the returned `workspace` ID. After it finishes, start a separate reviewer in the **same workspace**. Only one instance may be active there at a time.
3. Send necessary fixes to the original worker after review finishes. Integrate only reviewed changes, then verify the result in the parent directory.
4. To continue after integration or another instance's sync, explicitly choose `baseline: "keep"` (current workspace files) or `"sync"` (update from the parent). Sync refuses unintegrated or staged work; later integration applies only the new increment.

Integration leaves the parent's HEAD, index, and branches unchanged. Worktrees live under `<repo>.worktrees/`; dependencies and trust are not set up automatically. Shared `cwd` sessions do **not** isolate files, and worktrees do **not** isolate OS permissions.

Managed workspaces require Git with `check-attr --source` (tested on 2.50.1). Sparse checkouts, unmerged indexes, submodules, symlinks, and content filters such as Git LFS are refused. Cleanup is manual and requires authorization; inspect the worktree before removing it, and do not force removal to bypass a refusal.

## Safety and limitations

- **Approvals are single-action.** The extension does not grant session-wide or persistent permissions. A `humanOnly` request must be answered by a human through the panel or `/agent-reply <agentId> <questionId>`; the parent can deny/cancel it, not approve it. Approval is not proof of successful execution.
- **Conflicts are checked before integration writes**, but crashes or I/O failures can leave partial changes. Inspect retained patches, backups, and unfinished journals before retrying. Stale locks and crashed execution owners are not recovered automatically; pause external writers during snapshot/integration/sync.
- **Local records can contain sensitive source data.** Sessions, logs, snapshots, and backups live beside the parent session in `<parent-session-file>.subagents/` and are not deleted when an instance closes.
- **Compatibility has limits.** Pi is the primary end-to-end tested workflow. Codex protocol checks used CLI 0.159.2; Claude requires native Claude Code >=2.1.283 on PATH (`claude.exe` on Windows). Real-parent Pi → Codex/Claude orchestration, live TUI approval/baseline dialogs, and arbitrary crash recovery are not fully verified.

## Development

```bash
npm run check   # TypeScript check
npm test        # Build + deterministic tests; no model calls
```

After code changes, rebuild and run `/reload` in Pi. Automated tests are not full terminal acceptance. See the [delegation skill](skills/delegate-cli-agents/SKILL.md) for the detailed agent workflow.

Inspired by [Paseo](https://github.com/getpaseo/paseo) for lifecycle management and [pi-subagents](https://github.com/tintinweb/pi-subagents) for the status and conversation UI.
