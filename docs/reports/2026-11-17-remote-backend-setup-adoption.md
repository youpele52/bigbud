# Remote backend setup: adopting an existing managed agent install

**Date:** 17 November 2026
**Fixes:** the "fresh setup conflicts with D5 approval" blocker in
[WP-3A](2026-11-17-wp-3a-backend-deployment-relay-profiles.md)
**State:** Implemented, uncommitted. Unit and integration tested on macOS with a local stand-in
account. No VPS run yet. No Rust changes.

## Problem

`bigbud backend setup` only accepted an empty `~/.bigbud/agent`. A host approved through a managed
agent build (D5) already has a registry, installed builds and usually a running supervisor, so
deployment failed with `setup-failed` on most approved hosts.

## What setup now does

Setup checks the agent directory once, read-only, before it claims anything:

- **Fresh:** the directory is missing or holds only `account-authority-v1`. Behaviour is unchanged.
- **Adopt:** existing managed state passes every check below. Setup then claims the account and
  continues through the normal install and admission steps.
- **Refuse:** anything else fails with a typed reason before any change (`needsRepair: false`).

### Adoption rules (all must hold)

1. Top-level entries are only `account-authority-v1`, `control-v1`, `bin`, `runtimes`, `staging` and
   `inbox`. If `account-authority-v1` is present, it must belong to this backend and state root.
2. `control-v1/registry.json` is a private file that parses with the existing registry parser.
3. Nothing is in flight: no pending build, reserved stage or slot, in-progress update, open
   retirement or restart, prepared admission, reserved launch or deleting binary.
4. Nothing is uncertain: no `uncertain` update, ambiguous stage failure, `spawn-uncertain` launch, or
   pin, `current` or `predecessor` pointing at a missing build.
5. There are no legacy owners: no `unknown-legacy-owner` pin, no non-managed runtime, no legacy
   `state/` directory, and no v3 (mobile) registry owned by another backend.
6. Every present build is authenticated. Its bytes match the pinned sha256 with private ownership,
   and its `--check` identity matches the version, build digest, Linux and the architecture.
7. A signed candidate build that already ran must have its supervisor observed `ready` right now.
   A candidate that never ran must have an empty runtime directory.
8. Capacity: if no candidate build is installed, at most one other distinct build may be present.

### What adoption preserves

- **Live supervisors.** Setup never relaunches or stops a supervisor observed `ready`. It reuses the
  supervisor's runtime state, skipping the empty-generation step, and the admission connects to the
  running process. The boot reconciler already adopts such a live supervisor.
- **Laptop pins.** `connection:` pins recorded before adoption are reported as referenced, so the
  setup admission never releases them. Other pins and leases are not touched.

### Taking ownership atomically

The existing `account-authority-v1` hard-link claim is the ownership step. A concurrent claim by
another backend collides on the link. After the claim, setup checks that the directory listing and
the registry bytes still match the verified snapshot. If a laptop operation started in that window,
setup refuses with `install-in-progress` (`needsRepair: true`, nothing deleted). A retry adopts once
that operation has finished, because the claim is already ours.

## Refusal codes

The remote CLI prints `bigbud backend: Setup refused (<code>): …` on stderr. The laptop accepts only
known codes. It returns `setup-failed` with a new optional `reason` and its own fixed message, and it
never echoes remote text.

| Code                    | Meaning                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `foreign-owner`         | Another backend owns the account (authority or mobile registry)    |
| `unknown-state`         | Unrecognised entries, a non-private directory or no registry       |
| `legacy-owner`          | `unknown-legacy-owner` pin, an external runtime or legacy `state/` |
| `unverifiable-registry` | The registry is unreadable, unsafe or invalid                      |
| `unverifiable-build`    | Unauthenticated build, hash mismatch or `--check` mismatch         |
| `install-in-progress`   | An install, update, retirement or launch is running                |
| `ambiguous-state`       | An uncertain outcome, missing builds or orphaned runtime state     |
| `stale-supervisor`      | The candidate's supervisor stopped, for example after a reboot     |
| `no-capacity`           | Two other builds occupy the account                                |

## Files

- New:
  - `localSupervisorService.setup.adoption.ts` (gate, fence, pin preservation)
  - `localSupervisorService.setup.adoption.rules.ts` (pure rules, codes, CLI line)
- Changed:
  - `localSupervisorService.setup.ts` and `setup.runtime.ts` (`prepareSetupRuntimeState`)
  - `localSupervisorAuthority.ts` (claim option `adoptExistingState`)
  - `localSupervisorBinary.ts` (exported bytes-only verifier)
  - `deployment.remoteSetup.ts` and `deployment.types.ts`
  - `packages/contracts/src/server/remoteBackendDeployment.ts` (`reason`)

## Known limits and follow-ups

- The laptop's remote-agent install path does not yet respect `account-authority-v1`. After
  adoption a laptop can still write the registry. The registry compare-and-swap keeps this safe, but
  D7 single-writer coordination is not enforced yet.
- Later backend-side cleanup (`reconcileSupersededRemoteAgentConnections`) may release laptop
  `connection:` pins that the backend's owner store does not know. Check this before a long-running
  backend and a laptop share one host.
- Runtime-state reuse for a live supervisor is proven only with fixtures. The `--check` and
  observation scripts are faked on macOS.

## Live test checklist

1. On a D5-approved VPS with a managed agent and an open laptop terminal, deploy with
   `enableBoot: false`. Check that setup succeeds, the terminal keeps working, the supervisor PID is
   unchanged, `registry.json` still holds the laptop `connection:` pin, and `systemctl --user` shows
   no Rust unit started.
2. Run `bigbud backend start`. The backend should adopt the live supervisor (boot reconcile
   `adopted`) without starting a second one.
3. Reboot the VPS, then deploy to a fresh account copy. Check that you get `stale-supervisor`, then
   that a laptop reconnect followed by a retry succeeds.
4. Start a laptop install and deploy during it. Check for `install-in-progress` and that nothing
   changed.
5. Add a stray file to `~/.bigbud/agent`. Check for `unknown-state` and that the renderer shows the
   laptop message.
