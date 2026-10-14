# Managed workspaces

Read this before you create, sync or integrate a managed workspace. Tool descriptions cover routine
calls; [../SKILL.md](../SKILL.md) covers delivery, permissions and recovery.

A managed workspace is a detached Git worktree owned by this extension, created from committed HEAD.
Choose isolation according to the task's requirements; passing `cwd` instead uses that directory
directly without creating a worktree.

## Create

`subagent({ action: "workspace_create" })` reports the workspace but does **not** inherit uncommitted parent files. Inspect
its committed baseline and the `parentChanges` it reports before you spawn.

To inherit dirty files, inspect **all** current changes and get the user's authorization first.
`includeUncommitted.reason` records why the snapshot was taken; it does not grant the authorization, and
it does not authorize unrelated edits or a formal commit. The snapshot is an internal baseline commit;
it never moves the parent's branch, HEAD or index.

A sibling worktree may need its own dependencies and project trust. Do not force trust or widen
permissions to make a child start there.

## Work in it

One runtime owner per workspace, including an **idle** resident Pi/Codex instance. Explicitly stop it
before integration or handing the workspace to another instance. Another instance may use the same
workspace ID after the previous instance releases it; whether that next task is implementation, review or something else is your workflow.

## Sync and keep

When an instance continues work in an existing workspace, the baseline is an explicit choice:

- `baseline: "keep"` — continue with the workspace as it is. This is not a restore of remembered files.
- `baseline: "sync"` — update an idle, fully integrated workspace from the parent. Sync refuses
  unintegrated or staged work: **never reset or discard that work to make sync pass.** It closes only
  the target idle runtime before session preflight/synchronization/resume; other owners block it. A
  later refusal may leave that runtime closed with its original session and reports intact.

When you choose keep or sync, the extension appends a baseline notice to the child's input. It instructs the child to re-read the affected files, or all assigned files when the previous baseline is unknown or unavailable. The parent's tool result does not include that notice; no manual relay is needed. This instruction is not proof that the child re-read the files. Its saved conversation may describe older files. An older instance must acknowledge a changed baseline. keep preserves pending changes; sync cannot discard unintegrated work.

## Integrate

`subagent({ action: "workspace_integrate", workspace })` applies pending changes to the main directory. On conflicts, stop and
inspect rather than forcing application — see [recovery.md](recovery.md) for the stuck and uncertain
cases. Do not make branch commits, push, delete worktrees, or widen the task by default.

Worktrees are not permission sandboxes, and a separate conversation is not a separate filesystem:
coordinate with anyone else writing in either directory.
