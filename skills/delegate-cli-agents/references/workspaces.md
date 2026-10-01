# Managed workspaces

Read this before you create, sync or integrate a managed workspace. Everything else about delegation is
in [../SKILL.md](../SKILL.md).

A managed workspace is a Git worktree this extension owns, one per independently integrable change. Use
one when parallel work must not touch the parent directory; otherwise share `cwd`.

## Create

`create_workspace({})` reports the workspace but does **not** inherit uncommitted parent files. Inspect
its committed baseline and the `parentChanges` it reports before you spawn.

To inherit dirty files, inspect **all** current changes and get the user's authorization first.
`includeUncommitted.reason` records why the snapshot was taken; it does not grant the authorization, and
it does not authorize unrelated edits or a formal commit. The snapshot is an internal baseline commit;
it never moves the parent's branch, HEAD or index.

A sibling worktree may need its own dependencies and project trust. Do not force trust or widen
permissions to make a child start there.

## Work in it

One active instance per workspace. Give the reviewing instance the same workspace ID as the one that made
the change, and start it only after that instance stops.

## Sync and keep

When an instance continues work in an existing workspace, the baseline is an explicit choice:

- `baseline: "keep"` — continue with the workspace as it is. This is not a restore of remembered files.
- `baseline: "sync"` — update an idle, fully integrated workspace from the parent. Sync refuses
  unintegrated or staged work: **never reset or discard that work to make sync pass.**

After either choice, read the baseline or file-change notice and tell the child what to re-read; its
session memory is not a current view of the files. If a pruned acknowledged baseline means the exact
diff is unknown, have the child re-read all assigned files, not just the journal paths. An old reviewer
must acknowledge a worker's sync, and normally choose `keep`, so it reviews the pending changes instead
of syncing them away.

## Integrate

`integrate_workspace({ workspace })`, then verify the main directory yourself. On conflicts, stop and
inspect rather than forcing application — see [recovery.md](recovery.md) for the stuck and uncertain
cases. Do not make branch commits, push, delete worktrees, or widen the task by default.

Worktrees are not permission sandboxes, and a separate conversation is not a separate filesystem:
coordinate with anyone else writing in either directory.
