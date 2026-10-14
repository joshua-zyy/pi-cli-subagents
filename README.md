# pi-cli-subagents

[简体中文](https://github.com/joshua-zyy/pi-cli-subagents/blob/main/docs/README.zh-CN.md)

![pi-cli-subagents](https://raw.githubusercontent.com/joshua-zyy/pi-cli-subagents/main/docs/assets/readme-banner-v3.png)

Delegate work from a Pi session to persistent Pi, Codex CLI, and Claude Code subagents.

Each subagent keeps its own native session and its own process lifetime, so the parent can run
several tasks in parallel, keep working while they run, and continue any of them later without
restating the context. Questions and results return to the session that started them. Optional
managed Git worktrees keep parallel edits out of each other's way.

## Requirements

- Pi, tested to load and register on 0.87.1, 1.0.1, 1.1.0 and 1.2.0
- Node.js 22.19.0 or newer
- For Codex or Claude Code subagents, the matching CLI installed and logged in; Pi subagents need
  nothing extra

## Install

```bash
pi install npm:pi-cli-subagents
```

From a local checkout you have already built with `npm run build`:

```bash
pi install ./path/to/pi-cli-subagents
```

`pi install` writes to your personal settings; add `-l` to scope the entry to the current project.
Use `pi list` to see what is installed, and `pi -e npm:pi-cli-subagents` to try the package for a
single run without saving it.

Installing from a Git URL is not supported yet. The repository does not commit `dist/` and Pi does
not build a package while installing it, so a Git install would produce a package with no entry
point. Use npm or a built local checkout.

## Roles

Four roles ship as defaults:

| Role | Default purpose |
| --- | --- |
| `explore` | Investigate the code and report findings without changing project files |
| `worker` | Implement a task and verify the changes |
| `reviewer` | Review specified changes in an independent context |
| `oracle` | Answer a question or give a judgment from the material it is handed |

All four run on Pi and inherit the parent's model until you configure otherwise. A role is a launch
template: CLI, model, provider, thinking level, effort, permission mode, and instructions. Define or
override roles with `/cli-agents-setting`. Tools and UI never depend on a built-in role name, so the
four above are replaceable rather than a fixed hierarchy.

## Tools

| Tool | Use |
| --- | --- |
| `subagent` | `start`, `send`, `interrupt` and `stop` an instance; `workspace_create` and `workspace_integrate` for managed worktrees |
| `subagent_query` | Read-only `list`, `get`, `result` and `activity` over this session's instances |
| `subagent_reply` | Answer one pending task question, or review one permission request within the user's authorization |

Pi children can ask the parent a single task question through `subagent_ask_parent`.

## Behavior worth knowing

- **Results return on their own.** Completion, failure and waiting reports are delivered to the
  session that started the instance, and reach a busy parent before its next model request without
  cancelling a running tool. There is nothing to poll for.
- **A receipt is not execution.** `accepted` means the native CLI acknowledged the input. It does not
  mean the model read it or the work succeeded. Read the report and the files before claiming success.
- **Sessions persist, processes need not.** An instance keeps its native session, history and results,
  and `send` continues the same conversation. `stop` releases processes without deleting that history,
  and refuses while a turn it already accepted is still in flight: releasing that runtime would
  discard the turn, so `interrupt` it first. Whether a backend stays resident between turns is
  reported per instance rather than promised uniformly.
- **Answers are not permissions.** A reply supplies task context, or reviews one request. It never
  grants a session-wide or persistent permission.
- **Worktrees isolate; they are not a sandbox.** `workspace_create` makes a detached worktree from
  committed HEAD, and `workspace_integrate` applies only the pending changes, refusing conflicts
  instead of resolving them. Your HEAD, index and branches are left alone, and nothing is committed
  or pushed.
- **Stopping is not a rollback.** An uncertain outcome is reported as uncertain, and a native session
  is never silently replaced by a new one.

## In the session

The roster under the parent's reply lists every instance with its phase and elapsed time, and
`Ctrl+Alt+A` opens the same list while the parent is still working:

![The subagent roster under the parent's reply](https://raw.githubusercontent.com/joshua-zyy/pi-cli-subagents/main/docs/assets/subagent-running-ui.png)

`/agents` browses those instances, opens one conversation, and releases idle runtimes:

![The /agents panel](https://raw.githubusercontent.com/joshua-zyy/pi-cli-subagents/main/docs/assets/subagent-panel.png)

A conversation shows the task that was sent and the reply that came back, with the keys available at
the bottom of the pane:

![One instance's conversation](https://raw.githubusercontent.com/joshua-zyy/pi-cli-subagents/main/docs/assets/subagent-detail.png)

## Commands and keys

| Entry point | Use |
| --- | --- |
| `/agents` | Browse instances, conversations and results; reply, interrupt, or release from the panel |
| `/cli-agents-setting` | Configure roles in a pane above the editor |
| `Ctrl+Alt+A` | Open the roster while the parent is working |
| Inside `/agents` | `i` details, `r` reply, `t` interrupt, `x` release an idle instance, `c` release idle instances, `h` history |

Dispatch happens through the parent agent's tools and this panel. There is no `@role` prompt shortcut.

## Documentation

- [Operational reference](skills/delegate-cli-agents/SKILL.md), bundled with the package: how the
  parent should answer questions, handle approvals, read paged or truncated results, and recover from
  uncertain operations
- [Tool interface](https://github.com/joshua-zyy/pi-cli-subagents/blob/main/docs/subagent-tool-contract.md)
- [Development and testing](https://github.com/joshua-zyy/pi-cli-subagents/blob/main/docs/testing.md)

## Verification status

The local suite passes without calling a model. Real CLI and model acceptance has been recorded for
eight rounds covering Codex and Claude approvals, task questions, original-session resume, and
managed-worktree integration; those rounds can be replayed read-only. It has not been run on Linux or
macOS, on the full interactive TUI, or against the newest CLI versions, which have moved past the
ones those rounds were recorded on. Read the local pass as a statement about this repository's logic,
not about your installed CLIs.

## Credits

Adapted third-party code and the full license texts are in [NOTICE](NOTICE). The projects involved
are Paseo and Lody (both Apache-2.0), `@juicesharp/rpiv-ask-user-question` (MIT), and
[tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) as inspiration for the status and
conversation UI.

## License

[MIT](LICENSE) for this extension's own code. Third-party notices are in [NOTICE](NOTICE).
