# Production native mobile composition

**Date:** 17 November 2026
**Status:** In progress; increment 1 implemented (uncommitted), increment 2 in progress
**Baseline:** `dev` at `26aa117e12`
**Related:** [Remote agent plan](2026-11-13-remote-agent-manual-install-plan.md) (P7),
[Mobile remote access plan](2026-11-13-mobile-remote-access-plan.md) (P2–P4),
[Completion handover](2026-11-17-remote-mobile-completion-handover.md),
[Workspace status report](../reports/2026-11-17-remote-mobile-workspace-status.md)

## Goal

In the managed account-service remote backend on Linux, compose the native Rust service lease
so that it starts the mobile gateway, gates readiness on original-child proof, admits
authenticated mobile routes, and handles consent revoke → confirmed exit → same-CAS cleanup.
On controller restart, it runs the successor recovery. Production activation stays default-off
until every proof input is present.

## Finding

Every required part exists, but no production path calls them. Mobile route admission is
production-wired but dormant, because no readiness producer ever runs. Three things are missing
entirely:

- a native process port for the gateway owner;
- an attached activation controller;
- a production source of proof inputs (trusted keys, signed artifacts, durable consent).

Remote P7 increment 1 (remote profile, authority identity, missing-auth refusal,
typed-unavailable desktop hooks, remote listeners) is already present and wired.

## Current-state inventory

Paths are relative to `apps/server/src/` unless they start with `crates/`.

| Piece                                                                   | Status                                                                                     | Evidence                                                                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Remote profile/config (`mode: "remote"`, Linux-only, loopback callback) | Wired                                                                                      | `startup/config.remote.ts:17-85`, `server.ts:341-370`                                             |
| Account-service entry and preflight; exit 0 on requested stop           | Wired                                                                                      | `bin.ts`, `remote-backend/localSupervisorService.startup.ts`, `bin.serviceTeardown.ts`            |
| Missing client-auth refusal                                             | Wired                                                                                      | `startup/config.remote.ts:22-30`, `server.ts:345-359`                                             |
| Authority/key/installation identity, private state root                 | Wired                                                                                      | `remote-backend/authority.ts`, `authority.files.ts`, `identity.service*.ts`                       |
| Typed-unavailable desktop hooks                                         | Wired                                                                                      | `server.profile.ts:18-45`, `remote-backend/unavailable.*.ts`                                      |
| Remote listeners (client UDS, loopback callback TCP, mobile socket)     | Wired                                                                                      | `server.remote.ts`, `server.remote.routes.ts`, `server.platform.ts`                               |
| Rust terminals in remote mode                                           | Wired                                                                                      | `server.pty.ts` → `remote-backend/localSupervisorLayer.ts`                                        |
| Account-service lifecycle CLI and systemd user unit                     | Wired                                                                                      | `cli/cli.backend.ts`, `crates/bigbud-remote-agent/src/backend_service/unit.rs`                    |
| `acquireManagedNativeLeaseChannel`                                      | Exists; no production caller; `RemoteAgentRuntimeOwners` not provided at app level         | `remote-backend/localSupervisorService.leaseChannel.ts:56-160`                                    |
| Rust lease proxy                                                        | Exists                                                                                     | `crates/bigbud-remote-agent/src/backend_service/lease_proxy.rs`, `lease_context.rs`               |
| Activation authority                                                    | Exists; uncalled                                                                           | `remote-backend/mobileGatewayActivation.authority.ts`                                             |
| Signed-artifact publication                                             | Fixture-wired; no production key/artifact source                                           | `remote-agent/mobileOptionalPublication.ts`, `mobileOptionalArtifactPrepare.ts`                   |
| Desired-selection CAS write                                             | Fixture-wired                                                                              | `remote-backend/mobileGatewayActivation.selection.ts`                                             |
| Mobile preparation and private signer                                   | Test-wired                                                                                 | `remote-backend/mobileGatewayNative.prepare.ts`, `.guard.ts`, `.capability.ts`                    |
| Native Start and original-child readiness                               | Rust exists; TS client exists; not composed                                                | `service_lease/owner.rs`, `process.readiness.rs`; `remote-agent/remoteAgentServiceLeaseClient.ts` |
| Activation worker                                                       | Port-based; test-only                                                                      | `remote-backend/mobileGatewayActivation.worker.ts`                                                |
| Activation service/state                                                | Constructed; no controller attached; no RPC/CLI calls it                                   | `mobileGatewayActivation.service.ts`, `state.ts`, `server.mobileOwner.ts`                         |
| Neutral listener                                                        | Exists; uncalled                                                                           | `remote-backend/mobileGatewayListener.ts`, `.upstream.ts`                                         |
| Shared gateway owner / lifetime proof                                   | Constructed; `run` never called; hard-wired to a Node child                                | `remote-backend/mobileGatewayOwner.ts:97`, `mobileGatewayProcess.admission.ts:26`                 |
| Consent revoke                                                          | Wired                                                                                      | `remote-backend/mobileConsentRevoke.ts`, `ws/serverSettings.mobileConsent.ts`                     |
| Consent enable                                                          | Missing (fixtures only)                                                                    | `remote-agent/remoteAgentInstall.mobile.transitions.ts:107`                                       |
| Same-CAS native cleanup                                                 | Test-wired                                                                                 | `remote-backend/mobileGatewayAssets.nativeCleanup.ts`, `mobileGatewayProcess.assets.ts`           |
| Rust consent-off enforcement                                            | Exists                                                                                     | `crates/bigbud-remote-agent/src/service_lease/guard/worker.rs`                                    |
| Successor recovery                                                      | Rust exists; TS built but uncalled; restore-from-journal and successor exit record missing | `service_lease/recovery/`, `mobileGatewayActivation.successor*.ts`                                |
| Mobile route admission                                                  | Wired; dormant                                                                             | `remote-backend/mobileRoutes.ts`, `mobileControlAdmission.ts`, `mobileControlFacade.ts`           |
| Consent/activation CLI and settings                                     | Partial (`bigbud mobile pair` only)                                                        | `cli/cli.mobile.ts`                                                                               |
| Contracts                                                               | Adequate; no change needed for increments 1–5                                              | `packages/contracts/src/server/remoteBackendHandshake.ts`                                         |

## Increments

Shared rules for every increment:

- Use `Effect.fn("name")`.
- Keep opaque tokens; production paths never accept structural fakes.
- Every file stays at or under 400 lines.
- Run focused checks only: explicit-path oxfmt/oxlint, the server typecheck, and focused vitest
  through `bun run --cwd apps/server vitest run`. Never run `bun test`.

### 1. Native activation port binding

Bind `runMobileActivationWorker` to the real service-lease client, preparation, assets and
native cleanup, in the same style as `mobileGatewayActivation.successor.native.ts`.

**New files**

- `remote-backend/mobileGatewayActivation.native.ts`
- `mobileGatewayActivation.native.assets.ts`: production assets port that binds existing
  functions only.
- `mobileGatewayActivation.native.test.ts`, plus an optional fixture.

**Worker mapping**

- `prepareStart` calls `client.beginAttempt()` and returns an opaque handle backed by a WeakMap.
- `reserve` prepares assets, then calls `preparation.prepare`, then `preparation.reserve`. A
  `null` intent fails closed before Start. Then `markInvoked`.
- `start` calls `client.start`.
- `reconcile` maps `live` to a lease, `cancelled`/`exited` to `notAccepted`, and a throw to
  `uncertain`.
- `stop` calls `stopOriginal`; anything other than `exited` throws.
- `detach` calls `client.detach`.
- `cancelUnlaunched` follows progress: remove unarmed assets, or `originalNeverInvoked` then
  confirm then remove, or `cancelPending` then confirm then remove.
- `recordExit` confirms the exit, then removes the assets.

**Off by default:** pure library with no production import.

**Tests**

- Event order before the Start frame.
- Stop path records the exit.
- Lost-Start reconcile mapping.
- `cancelUnlaunched` branches.
- `null` intent.
- Detach-only.
- A `cancelled` stop result is not exit evidence.

**Done when:** macOS focused tests, typecheck and oxfmt/oxlint pass.

### 2. Native admission stamp and owner process port

- Extract single-flight batching from `mobileGatewayProcess.admission.ts` into
  `mobileGatewayAdmission.batch.ts`.
- Add `mobileGatewayNative.admission.ts`. It admits only when:
  - the journal row is `attempted` with matching `nativeOwnership`, consent revision and
    configuration;
  - consent is enabled;
  - `client.reconcile` reports `live` at the same generation.
- Give `mobileGatewayOwner` a `runWith(proof, input, processPort)`. The Node path becomes one
  port with unchanged behaviour.

**Tests**

- Admission requires both route verification and stamp equality.
- Consent-off leads to `disabled`; a stamp change leads to `revoked`.
- Generation, phase and revision mismatches are refused.
- Existing Node-owner tests stay green.

### 3. Native listener session

Add `mobileGatewayNative.session.ts`. Its order:

1. activation authority;
2. managed lease channel;
3. sealed upstream with a fresh credential;
4. native preparation;
5. worker, whose `use` is `owner.runWith` with the native port.

Extract the listener's shared validation prefix rather than duplicating it.

**Tests**

- macOS ordering tests.
- A Linux integration script on a disposable VM, labelled as not a managed-account proof.

### 4. Controller attach and composition, off by default

- `mobileGatewayActivation.inputs.ts`: a `RemoteMobileNativeInputs` service that stays
  `Option.none()` until increment 6.
- `mobileGatewayActivation.controller.ts`: activate (publish/remint → selection CAS → fork
  session), stop, close.
- `server.mobileActivation.ts`: attaches a controller only when inputs are present, and provides
  `RemoteAgentRuntimeOwners` at app level.

**Tests**

- With inputs absent, the default composition attaches nothing and does no IO.
- On darwin, `activate` returns `unavailable`.
- Retirement ordering is correct.

### 5. Successor recovery wiring

- `mobileGatewayNative.restore.ts` rebuilds `NativeLeaseRestore` from the journal, re-deriving
  the capability, then calls `client.restorePending`.
- `mobileGatewayNative.successorExit.ts` records a journal-only exit, reusing an exported
  completion helper from `mobileGatewayAssets.nativeCleanup.ts`.
- `controller.resume()` adopts at most one foreign `attempted` native row, runs
  `runMobileSuccessorRecovery`, and on `ready` hands off to `owner.runWith`.

**Live proof on Linux**

- `kill -9` the backend → restart → `attaching` → `spawned` → ready.
- Gone variant.
- Revoke during the successor run.

### 6. Proof inputs, consent enable and owner CLI (decisions D-A, D-B made)

- Owner-socket protocol additions: consent-enable, activate, stop, status.
- `bigbud mobile enable --confirm-consent | activate --origin --port | stop | status`.
- `RemoteMobileNativeInputs` reads an owner-private inputs file.

### 7. Live acceptance

Run on a fresh immutable graph and a fresh account (Lima VM): managed prepare → Start →
readiness → authenticated route → revoke → confirmed exit → same-CAS cleanup → backend
crash/restart successor.

- Run on both x86_64 and ARM64.
- Rebuild the native input of the prepared managed-channel packet from current source.
- Add an orphan runtime-asset repair path.
- Update the mobile ledger and the remote P7 section.

## Decisions

Both decisions were made by the user on 17 November 2026, accepting the recommendations.

- **D-A, decided: where proof inputs come from.** An owner-private inputs file next to the
  backend-service config holds trusted keys, signed descriptors and local artifact paths,
  mirroring `backend setup --trusted-keys`. Absent or invalid inputs mean off. Downloading from
  the release manifest was considered and not chosen.
- **D-B, decided: who grants durable consent.** Only an explicit owner CLI command on the host,
  with confirmation, can grant durable journal consent. The settings toggle stays revoke-only.

## Risks

- Runtime asset trees left after a successor exit cannot be re-adopted by design
  (`mobileGatewayProcess.assets.ts:160`). They need a repair/GC path in increment 7.
- Liveness reads cost a native status round-trip each. Batch them, and keep the 20 s IO timeout
  above the 10 s native readiness limit. A timed-out Start stays uncertain.
- A Rust agent restart changes the epoch. A retained lease from an older epoch must resolve to
  uncertain (needs repair), never to a fresh Start.
