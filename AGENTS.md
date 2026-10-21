# pi-cli-subagents

## Product purpose

Provide Pi with CLI subagent dispatch and management using the user's
existing Pi, Codex CLI, and Claude Code installations. Preserve native
sessions, support multi-turn collaboration, and return results and
blocking requests to the originating parent session.

The extension provides collaboration mechanisms, not collaboration
policy. Users and parent agents decide what to delegate, which roles to
use, and how to organize their work.

## Product scope and non-goals

The following boundaries govern the extension's shipped behavior, not
the tools or workflows maintainers may use to develop this repository.

- Own dispatch, continuation, interruption, runtime release, observation,
  result delivery, and question/approval bridging. Necessary identity,
  ownership, admission, and uncertainty safeguards belong to this scope.
- Do not add workflow languages, pipelines, schedules, councils, fleet
  management, shared team task boards, or arbitrary cross-session messaging
  without an explicit change to product scope.
- Do not make the extension impose role sequences or mandatory reviews,
  or perform automatic assignment, instance reuse, retries, or session
  replacement.
- Do not make the extension manage Git or directory lifecycles, or ship
  worktree-specific tools or skills. Accept an existing `cwd`; callers
  manage branches, worktrees, integration, and cleanup. A working directory
  is not a sandbox.
- Agents launched as children by the extension must not delegate to
  grandchildren through this extension or native backend delegation tools.
  Do not add an opt-in escape hatch.

Repository development may use multi-agent review and an iteration
workflow. That is a maintainer practice, not a workflow to embed in the
product.

## Contracts to preserve

- Preserve original parent, instance, run, and native-session identity.
  Continuation must not silently create a replacement session or replay
  an earlier assignment.
- Keep acceptance, task completion, interruption, native release, and
  accounting reclamation distinct. Preserve uncertainty; stopping does
  not roll back file changes.
- Queries must remain read-only and must not start, resume, stop, or approve
  work. Keep result truncation visible and retained full reports retrievable.
- Replies address the original request within the user's authorization.
  Task answers are not permission grants; do not broaden authorization to
  session-wide or persistent access.
- Keep existing management UI capabilities and runtime safeguards when
  simplifying. “Minimal” does not mean a one-shot delegator or removal of
  necessary control, observation, and approval capabilities.

## Interface and context economy

- Keep resident tool descriptions focused on the unified contract.
  Report actual backend capabilities through instance responses.
- In shipped operating guidance, direct agents to load only the relevant
  backend reference when needed. Necessary differences must be known before
  an operation, not learned through avoidable failed calls.
- Keep role discovery focused on names and responsibilities, not full
  instructions or backend manuals. Roles are configurable templates,
  not a mandatory hierarchy.
- Add backends in response to demonstrated demand, not speculative
  future needs.
- Do not claim better model performance merely from using a native
  harness. Target cross-platform operation and state verification limits
  honestly; untested is not the same as unsupported.

## Development and verification

Use npm and the existing test runner. Edit source files rather than
generated `dist/` output; update tests, scripts, skills, and documentation
when the task requires it.

Commands:

```bash
npm run check
npm run build
node scripts/test.mjs <tier> [test-file.test.mjs ...]
npm run gates
npm run gates -- --slow
```

The local tiers are `fast`, `domain`, `acceptance-local`, and
`acceptance-slow`. Select affected tests using `scripts/test-tiers.json`
and the rules in `docs/testing.md`. Every new `.test.mjs` file must belong
to exactly one tier. Direct runner calls require a current build.

Local gates use fixtures and do not establish real-model, native CLI,
manual TUI, or cross-platform acceptance. Report those evidence levels
separately.

Consult `docs/subagent-tool-contract.md` for detailed behavior and
`docs/testing.md` for verification procedures. Keep detailed procedures
and historical acceptance records out of this file.
