# Peer refusal before acceptance and setup permission reasons

**Date:** 18 November 2026. **Base:** `dev` at `bdb252c77b`, with the changes below not committed.

This closes two open items from `2026-11-18-remote-mobile-completion-status.md` ("Known open
items") and the harness note in `2026-11-18-p8-live-acceptance.md` ("Fixes and re-run").

## 1. Delegate refused before acceptance

**Before:** the tool returned `sent-uncertain`. Later the worker definitively refused the re-sent
delegate (for example `grant-revoked`). The follower moved the row `rejected` → `failed` and
delivered nothing, so the coordinator thread waited forever.

**Now:** `settleRejected` in `peerDispatch.follow.ts` handles every refusal before acceptance. That
covers a final delegate refusal from `pending` or `sent-uncertain`, and a missing stored request.
It asks `deps.toolWaits.handOff(dispatchId, error)` who reports the refusal:

- **A `delegate_to_host` call is still waiting in-call:** the refusal is recorded for that call and
  nothing is delivered. The tool returns `failed` with the refusal as its answer. If the row has not
  settled yet, the tool overlays `failed` on it.
- **No tool call is waiting:** this means the tool already returned, or the backend restarted. One
  failure result is delivered with `buildPeerResultDelivery` and `peer-result:<dispatchId>`, which
  is the same path F-P8-4 uses. The row then settles `failed`.

`peerDispatch.toolWait.ts` holds the in-memory registry. The service calls `enter` before it starts
the follower and `leave` on exit from its bounded wait, including interruption. Both sides decide
synchronously, so they are linearized: either the tool reports the refusal or the follower delivers
it, never both. Delivery happens before settlement, so a crash between the two re-delivers under
the same command id when the backend resumes. The orchestration receipt keeps that to one turn.

Limit: if the tool's own row read fails after a refusal was handed to it, the tool returns an error
instead of the refusal, and nothing is delivered.

## 2. `backend setup` names the non-private path

**Before:** a trusted-keys file at mode 0644, or a graph or home directory that was not 0700, made
setup print only "Operation unavailable or incomplete".

**Now:** the existing checks throw `PrivatePermissionError` (`remote-backend/privatePermission.ts`).
It keeps the original message and refusal and adds the path, its observed mode, the accepted modes
and whether this account owns it. `describeBackendFailure` prints one line that names the path, its
mode, the required mode and the fix, for example:

```
The trusted-keys file (--trusted-keys) '/home/u/trust.json' has mode 0644; it must be 0600 (private to this account). Run: chmod 600 '/home/u/trust.json'
```

Covered paths:

| Path                                                    | Check                                                                  | Fix suggested                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `--trusted-keys`, `--graph-manifest`, `--rust-manifest` | `readLocalSupervisorServiceFile` (labelled in `cli.backend.inputs.ts`) | `chmod 600`                                                               |
| Graph root, subdirectories, member files                | `backendGraph.files.ts`                                                | `chmod 700` / `chmod 600`                                                 |
| Backend home, account home                              | `assertLocalSupervisorServiceDirectory` (labelled in setup validation) | `chmod 700`; account home: the closest accepted mode (0700, 0750 or 0755) |
| Backend state directory, identity file                  | `authority.files.ts` (the cause of `RemoteBackendAuthorityError`)      | `chmod 700` / `chmod 600`                                                 |

A path owned by another account gets a `chown "$(id -u)"` hint instead. Paths are shell-quoted. A
path with control characters, or longer than 1024 characters, is never echoed. No file content is
included. Other private errors keep the generic text.

The Rust launcher re-checks these modes, but the TypeScript checks run first. Native refusals were
already printed through `Caused by:`, so the Rust code is unchanged.

## Checks

- `bunx oxfmt` and `bunx oxlint` on the 16 changed files, listed explicitly: clean.
- `bun run --cwd apps/server typecheck`: no diagnostics in the changed files. The remaining errors
  are in files other agents are editing (`ProviderCommandReactor`, `ProviderRuntimeIngestion`,
  `mobile*`, an integration test).
- Focused Vitest, 20 files: 120 tests passed.
- Mutation checks. Delivering unconditionally fails the synchronous-refusal test. Never delivering
  fails the late-refusal and replay tests. Dropping the CLI permission reason fails all 4
  setup-input tests.
- `clientRelay.credentials` and `clientRelay.leases*` fail on macOS with or without these changes:
  they are Linux-only, and the helpers were reverted to check this.
