# O-1: installation id as the fallback machine identity

**Date:** 18 November 2026
**Decision:** [completion status, decision O-1](2026-11-18-remote-mobile-completion-status.md)
**Finding:** [M2/M3 live acceptance, O-1](2026-11-18-m2-m3-live-acceptance.md)

## Problem

`node:24.13.1-bookworm` has no `/etc/machine-id`, so the laptop's remote-agent controller scope
was `unknown`. `isRemoteAgentControllerAlive` then failed closed for every earlier controller, and
reattach after a laptop `kill -9` was refused with "Previous remote input controller is live or
unconfirmed". A boot-id fallback was rejected because it would stay stuck after a reboot.

## Change

- **Installation id** (`packages/shared/src/machineIdentity.installation.ts`): 256 random bits,
  stored as 64 lowercase hex characters and a newline in `<bigbud home>/identity/installation-v1`.
  The bigbud home is `BIGBUD_HOME` (or `T3CODE_HOME`), otherwise `~/.bigbud`. The directory is a
  real 0700 directory and the file is a real 0600 regular file, both owned by the user. It is
  created once: an `O_EXCL|O_NOFOLLOW` temp file is written and synced, then hard-linked into place.
  Unlike `rename`, a link never replaces an id that another process published first, so
  concurrent first starts converge on one id. Reads use `O_NOFOLLOW`, and the format and size are
  checked strictly. If the file is a symlink, too permissive, unreadable or corrupt, it is refused
  and never replaced, because a new id would make the earlier controllers look foreign. Windows is
  not supported, because private modes cannot be verified there.
- **Fallback identity** (`resolveLocalHostIdentity` / `localHostIdentity` in
  `packages/shared/src/machineIdentity.ts`): this returns the platform `machine-v1:` identity when
  there is one. That identity is unchanged, so no migration is needed. Otherwise it returns
  `install-v1:sha256("bigbud.installation-identity.v1\0" + id + "\0" + hostname)`. The prefix keeps
  it separate from every machine identity. The hostname is bound in because the id is per account
  home, not per host, so two hosts that share one home (for example over NFS) still get different
  identities. A refused file gives `source: "none"` with a reason that names the file.
- **`machineIdentity()` itself still uses only the platform id.**

## Callers

| Caller                                                                         | Uses                          | Behaviour without `/etc/machine-id`                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remote-agent controller scope (`remoteAgentController.ts`)                     | `localHostIdentity` (changed) | The scope is `sha256(install-v1:… : pid namespace)`. A backend that restarts in the same container recognises its dead predecessor (ESRCH), so reattach works. If the id is refused, the scope stays `unknown`, and the claim error now appends the reason. |
| State-dir lock (`stateDirLock.ts`)                                             | `machineIdentity` (unchanged) | Keeps the hostname rule. A container's hostname is stable for its lifetime, so this already worked.                                                                                                                                                         |
| Workspace-mode reservations (`workspaceMode.local/.gate/.ssh/.record`)         | `machineIdentity` (unchanged) | Unsupported hosts are still skipped. An SSH probe can reproduce only `machine-v1:`, and a per-account id must not stand in for per-host identity.                                                                                                           |
| Backend instance, authority, process ledger, mobile gateway, desktop ownership | `machineIdentity` (unchanged) | Unchanged: the authority still refuses without a machine id, and ownership records still require `machine-v1:`.                                                                                                                                             |

**Limits.**

- Recreating or restarting a container gives a new PID namespace, so the old controllers look
  foreign and fail closed. This is correct, because the backend cannot tell them apart from a live
  sibling container that shares the home volume.
- Two hosts that share one home and have the same hostname, both in the initial PID namespace,
  cannot be told apart.
- If the hostname changes on a host without a machine id, the identity changes, and the old
  controllers fail closed.

## Checks

- Explicit-path `bunx oxfmt`, `oxfmt --check` and `oxlint` on the 10 changed TS files: clean. All
  of them are 400 lines or fewer.
- Typecheck of `packages/shared`, `apps/server` and `apps/desktop`: clean.
- Focused Vitest:
  - shared `machineIdentity.installation` and `machineIdentity.fallback`: 16 tests.
  - server `remoteAgentController.installation`, `remoteAgentController`, `utils/machineIdentity`,
    `remoteAgentOwnedPty.input`, `remoteAgentOwnedPty.profile`, `remoteAgentPtyClient.reconcile`
    and `localSupervisorLayer.owners`.
  - desktop `ownershipRecovery`.
  - All passed.
- Mutations, each of which failed at least one test:
  - following symlinks for the file or the directory
  - no mode check
  - no hostname binding
  - no fallback
  - `rename` instead of `link`
  - minting over a corrupt file
  - a controller that ignores the fallback
- **Container:** a disposable `node:24.13.1-bookworm` container with no `/etc/machine-id` or
  dbus id.
  - Two separate starts gave the same `install-v1:` identity and the same controller scope.
  - The files were `drwx------` and `-rw-------`, owned by `node`.
  - A `kill -9`ed process returned ESRCH.
  - After `docker restart`, the identity was the same and the scope was new, as expected.
  - The container was removed.
