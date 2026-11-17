# Remote agent completion plan (P1–P8)

**Date:** 17 November 2026
**Status:** In progress. The user asked for every phase to be finished autonomously; the user does
live testing. Milestone commits are made without pushing.
**Baseline:** `dev` after `a6fa01fee0`
**Related:** [Remote agent plan](2026-11-13-remote-agent-manual-install-plan.md) (authority for
phases and acceptance), [Production native mobile composition](2026-11-17-production-native-mobile-composition-plan.md),
[Workspace status report](../reports/2026-11-17-remote-mobile-workspace-status.md)

This plan comes from a read-only gap analysis of current source. "Wired" means a production path
calls the code; it does not mean live-tested.

## Status by phase

| Phase                                                             | State                                                                       | Remaining                                                                                                                              |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| P1–P5 install, static build, manual adoption, CLI, capability     | Done and wired in source                                                    | Supervisor SIGTERM handling (bug), published-script verification, D4 glibc drop timing, Windows and native x64 runs, PAM logout/reboot |
| P6 persistent terminals                                           | Live PASS on HEAD for S1–S5, prior boot, restart status, P6-7, P6-4b, P6-4c | Exit-130 under real systemd (blocked by M1); Linux-client subset (running)                                                             |
| P7 increment 1: remote profile and authority                      | Done and wired                                                              | None                                                                                                                                   |
| P7 increment 2: Rust terminals, crash-loop limit, D8 boot startup | Mostly wired                                                                | Explicit `backend start/stop` without boot startup; live systemd proof (needs M1)                                                      |
| P7 increment 3: authenticated transport, multiple clients         | Partial                                                                     | Relay profile producer; renderer per-backend binding; backend-scoped storage; multi-client tests                                       |
| P7 increment 4: workspace ownership, safe updates                 | Missing                                                                     | Mode reservation, archive store and retention, downgrade refusal, D9/D10 update operation, drain, disk gate, UI                        |
| P7 increment 5: nine-provider provisioning                        | Missing                                                                     | Recipe registry, service PATH discovery, lazy optional imports, conformance harness                                                    |
| P7 increment 6: bounds, measurement, release                      | Missing                                                                     | Measurement script, notices and provenance handoff                                                                                     |
| P8 peer orchestration                                             | Missing                                                                     | Contracts, worker peer endpoint, peer transport, coordinator dispatch, tool and setup UX                                               |

The single most important step is **M1**, a backend graph producer that packages the real tsdown
bundle. It unblocks exit-130 under systemd, logout/reboot, every later P7 live row and mobile
composition increment 7.

## Milestones and work packages

Shared rules: `Effect.fn("name")`; contracts schema-only; every code file at most 400 lines (put new
logic in new dot-notation modules when files such as `wsRpcClient.ts`, `server.ts`,
`supervisor/core.rs` or `wsTransport.ts` are near the limit); focused checks only.

### M0: P1–P4 leftovers

- **WP-0A, supervisor SIGTERM/SIGINT/SIGHUP (Rust).** Self-pipe `sigaction` handler with
  `SA_RESTART`; on a signal, stop admission, settle owned work with the existing tree-aware Stop
  (`supervisor/drain.rs`), remove the socket, exit 143 when settled or 1 when not; 15 s cap.
  Tests include a real PTY job-control child that must not be orphaned to PID 1, and default
  signal disposition in PTY children.
- **WP-0B, published-script verification and D4 cutover prep.**
  `scripts/verify-published-remote-agent-script.ts` compares `https://bigbud.app/remote-agent.sh`
  to the repo file; the `release.yml` glibc drop is prepared but held until D4 timing is set.

### M1: production backend graph

- **WP-1A, loader policy and reachability-aware closure validation.** Allow only the tsdown
  `createRequire(import.meta.url)` shim and reviewed dynamic loaders; allow absent externals
  (node-pty, Playwright, Bun variants) only when statically unreachable; `.node` addons must match
  the target ELF machine. Manifest stays at revision 1; the policy hash goes into provenance.
- **WP-1B, graph assembler for the real bundle.** `apps/server/dist` plus a sha-pinned Node 24
  Linux runtime, target externals installed with lifecycle scripts disabled, private file modes,
  collected notices, signed by `buildRemoteBackendGraph`; deterministic.
- **WP-1C, dev command and CI job** for aarch64 and x86_64 gnu graphs.
- **WP-1D, explicit `backend start/stop` (D8) and a musl launcher on a gnu graph.**

### M2: P7 increment 3, transport and multiple clients

- **WP-3A** laptop-driven backend deployment and persisted relay profiles.
- **WP-3B** one renderer window per remote backend (`?backend=<profileId>`), never touching the
  local singletons.
- **WP-3C** backend-scoped persisted storage keys for about 25 stores.
- **WP-3D** multi-client acceptance tests (one receipt per command, one approval answer,
  snapshot plus tail, revision refusal, late frames after key rotation).

### M3: P7 increment 4, workspace ownership and safe updates

- **WP-4A** workspace runtime-mode reservation (host, uid, realpath, mode, owner), explicit idle
  conversion only.
- **WP-4B** runtime archive store, retention and newer-schema startup refusal.
- **WP-4C** single-flight update operation, operation-bound consent, setup authority (D9/D10).
- **WP-4D** drain, disk gate, `VACUUM INTO` backup and activation with rollback only before any
  command is admitted; Rust terminals excluded from drain.
- **WP-4E** update UI in the remote window.

### M4: P7 increment 5, provider provisioning

- **WP-5A** recipe registry covering every `SELECTABLE_PROVIDER_KINDS` entry (test fails on a
  missing kind).
- **WP-5B** service and non-interactive PATH discovery; explicit paths win.
- **WP-5C** provisioning action (Copilot through its pinned installer, Pi through the graph
  closure, the rest report exact manual commands) and lazy optional adapter imports.
- **WP-5D** live conformance harness with a redacted dated matrix.

### M5: P7 increment 6, bounds and release handoff

- **WP-6A** measurement script (process-tree RSS/CPU, readiness and reconnect latency, DB growth
  at 1/4/8 sessions) and bounded-queue audit fixes.
- **WP-6B** notices and provenance handoff document.

### M6: P8 peer orchestration

- **WP-8A** schema-only peer contracts and migrations.
- **WP-8B** worker peer socket with a delegate/status/follow/cancel allow-list.
- **WP-8C** SSH forced-command peer transport.
- **WP-8D** coordinator dispatch, follow, cancel and restart resume; uncertain sends never
  relaunch.
- **WP-8E** `delegate_to_host` tool (typed unavailable without a grant) and pairing/revoke UX.

## User test checklists

Each milestone's live checklist (M0 SIGTERM and published script; M1 systemd stop/kill/start-limit,
Rust terminal survival, PAM logout and reboot on arm64 and x86_64; M2 two-laptop approval and
30-minute recovery; M3 deferred/interrupting updates, disk-full refusal and downgrade refusal;
M4 nine-provider conformance per tuple; M5 measurements on 1 GB and 4 GB VPSs; M6 coordinator with
two workers and fault injection) is maintained in the validation reports written as each
milestone lands.

## Decisions (defaults the work proceeds on)

1. Supervisor SIGTERM stops all owned work tree-aware, then exits 143.
2. One window per remote backend, not a unified multi-host sidebar.
3. Backend tier is glibc only; Alpine/musl hosts keep the Rust-only terminal tier.
4. node-pty and Playwright are excluded from the remote graph; browser and computer-use stay
   typed unavailable.
5. Graph distribution: signed release assets per target, pinned by sha256, with a laptop-upload
   fallback and a dev local-graph override.
6. bigbud provisions only Copilot and the Pi closure; the other seven providers reuse
   user-installed tools with exact manual commands. No vendor installer scripts.
7. SSH-relayed laptop clients have setup authority; paired mobile clients are viewers.
8. Workspace conversion is explicit and idle-only, with no history migration.
9. Keep active and previous runtimes; roll back automatically only if the new runtime fails
   readiness before admitting any command.
10. P8 transport: coordinator-generated SSH key with a worker forced command limited to the peer
    socket.
11. Linux-client subset: approved by the user on 17 November (downloads and about 6 GB).
12. D4 musl-only release: the release after the backend graph first ships.
13. Release blockers that only the user can resolve: Claude agent SDK and Copilot CLI
    redistribution terms, signing keys and publication.

## Parallel lanes

- **Lane A (Rust):** WP-0A, then the Rust half of WP-1D.
- **Lane B (scripts and server core):** WP-0B, WP-1A → 1B → 1C, then 3A, M3 server packages, M4,
  then P8 server packages.
- **Lane C (web and desktop):** WP-3B and 3C, then 4E, then the P8 UI; WP-3D can go in B or C.

Do not edit mobile-owned files while the mobile composition lane runs: `server.mobileActivation.ts`,
`remote-backend/mobileGateway*`, `mobileOwnerPairing*`, `cli/cli.mobile*`,
`localSupervisorService.leaseChannel*`, `remote-agent/remoteAgentServiceLeaseClient*` and
`crates/bigbud-remote-agent/src/service_lease/**`. New remote RPC handlers register through the WS
handler registry and `server.remote.routes.ts`; the P8 peer socket's one-line merge into
`server.remote.ts` waits until mobile increment 7 lands. WP-0A only calls
`stop_service_lease`, never edits it. Mobile increment 7 depends on M1.
