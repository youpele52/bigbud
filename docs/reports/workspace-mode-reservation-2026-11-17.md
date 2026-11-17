# Workspace runtime-mode reservation (WP-4A)

**Date:** 17 November 2026
**Plan:** [Remote completion plan](../plans/2026-11-17-remote-completion-plan.md), M3 WP-4A,
decision 8

## What it does

A folder on a host is used in one of two modes:

- **laptop-runtime**: a laptop bigbud backend runs providers against the folder over SSH.
- **remote-runtime**: the bigbud backend running on that host owns the folder.

The same host, account and real path cannot be used in both modes, because two backends would
write the same tree. Symlinks and other alias paths resolve to the same real path on the host, so
they share one reservation.

## Where reservations live

On the workspace host, in the account that uses the folder:

```
~/.bigbud/workspace-modes/          0700, never a symlink
  <key>/                            0700, key = sha256(hostIdentity \n uid \n realpathSha256)
    <generation>.json               0600, immutable, canonical JSON record
```

The record holds `hostIdentity` (the same `machine-v1:` digest as the backend lock),
`accountUid`, `realpathSha256`, `mode` and `owner` (a hashed backend identity, or `null` after a
conversion until the new mode's backend claims it). A new generation is published by an
exclusive hard link of a complete temp file, so only one writer can win each generation. The
previous generation is kept so concurrent readers never miss a record.

A laptop reaches the files through the clean POSIX SSH wrapper, and real paths are resolved on the
host. The remote backend uses the same files directly. Hosts that are not Linux or have no
machine ID cannot run a remote backend, so they need no reservation and are skipped.

## When a reservation is taken

- **Creating a project or changing its folder** reserves first. If the other mode holds the
  folder, the command is refused with a message that names the owner and how to proceed. If the
  host cannot be reached or the storage is unsafe, creation is refused and asks you to check the
  connection and retry.
- **Existing projects** (created before this change) have no reservation. They claim one lazily
  on their next turn, in their current mode. If the other mode already holds the folder, that
  turn is refused. If the host cannot be reached, the turn continues and a warning is logged, so
  existing setups keep working. Confirmed folders are cached for five minutes per backend.
- Desktop and web backends do not reserve local folders. Only SSH folders and the local folders of
  a remote backend take part.
- Deleting a project does not release its reservation, because other projects or laptops may
  share it.

## Conversion

Conversion is explicit and only happens while the folder is idle. Only a backend that currently
uses the folder in the reserved mode can convert it. That backend checks that none of its projects
on the folder, including alias paths, has a running turn, admitted work, an activity or worktree
lease, or an open terminal. Otherwise it refuses with the reason. History is not migrated: the old
projects stay where they are and are refused from then on.

The server entry point is `convertBackendWorkspaceMode`. There is no RPC or UI for it yet; that
belongs with the remote-window UI work (WP-4E). Until then, if a folder is no longer used by any
backend, you can release it by deleting `~/.bigbud/workspace-modes/<key>/` on the host.

## Live check for the user

On a Linux host with a remote backend installed:

1. From the laptop, create an SSH project for `/home/<you>/demo`, and confirm that
   `~/.bigbud/workspace-modes/` on the host gains one `<key>/1.json`.
2. In that host's remote backend window, try to create a project for `/home/<you>/demo-link`, a
   symlink to `demo`. Expect the laptop-runtime refusal message.
3. Remove the reservation directory and repeat in the other order: the remote backend creates
   first, and the laptop SSH project is then refused with the remote-runtime message.
4. With an SSH project created before this change, send a turn and confirm the reservation
   appears with `"mode":"laptop-runtime"`.
