# Remote and mobile completion status — 18 November 2026

## Summary

Every phase of the [remote agent plan](../plans/2026-11-13-remote-agent-manual-install-plan.md)
(P1–P8, tracked in the [remote completion plan](../plans/2026-11-17-remote-completion-plan.md))
and the [production native mobile composition](../plans/2026-11-17-production-native-mobile-composition-plan.md)
is implemented and committed on `dev`. Every live-testable part has been run on disposable Lima
Ubuntu 22.04 arm64 VMs with fixture-signed builds from `git archive` snapshots. Each live run
found defects. Some fixes have been re-run live; the later ones are so far verified only by unit
and focused tests (see [Fixes and how they were verified](#fixes-and-how-they-were-verified)). A
live arm64 re-run of the test-only fixes is in progress, and its report will follow. What remains
after that needs real infrastructure, credentials, hardware or a decision that only the user can
provide.

Nothing has been pushed. As of `e84335fe60`, `dev` is 74 commits ahead of `origin/dev`.

## Proven live (arm64 Lima, fixture keys)

| Area                                                                                                                                                                                                                                                                                                                                                                                      | Evidence                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| P6 persistent terminals: S1–S5, real prior-boot recovery, restart status, P6-7, P6-4b, P6-4c, Linux-client rows, Electron Quit/relaunch                                                                                                                                                                                                                                                   | [P6 acceptance](2026-11-17-remote-p6-head-acceptance.md)                                                            |
| M1 managed backend under systemd: setup, start/stop, exit 0 on stop, crash restart, crash-loop needs-repair, terminal survival, SIGTERM reaping, no-linger accounts, boot autostart 3/3                                                                                                                                                                                                   | [M1 acceptance](2026-11-17-m1-live-systemd-acceptance.md)                                                           |
| M2 deployment and multi-client: laptop deploy from macOS with an agent-held key, adoption, idempotent retry, hash-mismatch, laptop upload, one receipt per command, one approval answer, snapshot plus tail, relay pinning. Not run: 30-minute recovery and two physical laptops (two relay leases from one laptop stood in)                                                              | [M2/M3 acceptance](2026-11-18-m2-m3-live-acceptance.md)                                                             |
| M3 safe runtime updates: automatic deferral then activation, pending approval blocks, interrupting update with consent, stale consent, Rust terminal PID unchanged, disk-full and downgrade refused, failed-trial rollback, interrupted restore, manual recovery, workspace-mode reservation                                                                                              | [M2/M3 acceptance](2026-11-18-m2-m3-live-acceptance.md)                                                             |
| M5 measurements (1/4/8 sessions) and linux/arm64 deletion                                                                                                                                                                                                                                                                                                                                 | [Measurements](2026-11-18-remote-backend-measurements.md), [arm64 deletion](2026-11-18-linux-arm64-deletion-fix.md) |
| M6 / P8 peer orchestration: pairing with confirmed pin, delegation, partition recovery with one child per dispatch, coordinator restart, cancel during partition, revoke, host-key pinning, forced-command isolation, laptop-free completion, restarted workers. Not covered: the Settings > Peer hosts UI live, approval waits on the worker, grant expiry, two physical laptops, x86_64 | [P8 acceptance](2026-11-18-p8-live-acceptance.md)                                                                   |
| Mobile native composition: inputs, consent, activation, original-child readiness, revoke with confirmed exit and same-CAS cleanup, successor adoption, Gone path, orphan repair, evidence-based resolve                                                                                                                                                                                   | [Increment 7](2026-11-18-mobile-increment-7-live-acceptance.md)                                                     |

## Verified in code only (focused tests, mutation-checked)

- M4 provider provisioning and lazy optional SDKs; the conformance harness self-test (counts as no
  acceptance).
- Renderer per-backend windows, backend-scoped storage, the update UI and the peer pairing UI
  (unit and browser tests; no packaged-app run).
- Release notices, the Rust licence inventory, and the CI workflow for backend graphs (not yet
  run on GitHub Actions).
- Reproducible builds: tsdown on rolldown 1.1.5 gives byte-identical server bundles and graph
  archives; loader-region re-pins were security re-reviewed.

## Fixes and how they were verified

Fixed and re-run live (arm64 Lima):

- M1 lifecycle defects F1–F7 (`376819c1fd`), re-run with 3 of 3 boot autostarts
  ([M1 acceptance](2026-11-17-m1-live-systemd-acceptance.md)).
- M2/M3 runtime update and deployment defects (`31ad97c358`)
  ([M2/M3 acceptance](2026-11-18-m2-m3-live-acceptance.md)).
- P8 defects F-P8-1–F-P8-4 and idle-project hydration (`d220098854`)
  ([P8 acceptance](2026-11-18-p8-live-acceptance.md)).
- Mobile gateway defects F1–F8 (`55bb012f73`)
  ([Increment 7](2026-11-18-mobile-increment-7-live-acceptance.md)).
- Thread and project deletion on linux/arm64 (`295df61927`); single deletes and the project
  delete pass live ([arm64 deletion](2026-11-18-linux-arm64-deletion-fix.md)).
- Launcher rollback of a runtime update that never starts (`8ce8df26e7`)
  ([report](2026-11-18-launcher-rollback-unbootable-runtime.md)).

Fixed, verified by unit and focused tests only (not yet re-run live):

- Canonical compaction stall and project cascade resource leak (`d8beeded52`), which also covers
  the arm64 deletion report's DEFERRED cascade, project and retention rows and its PARTIAL manual
  retention row.
- O-2 (20 s backend stops with open WebSockets) and O-6 (repeated Chats bootstrap)
  (`51ce573251`, [report](2026-11-18-o2-o6-shutdown-and-chats-bootstrap.md)).
- Unbounded structures F-B1–F-B3 and F-B5–F-B9 ([report](2026-11-18-unbounded-structures-fixes.md)),
  and F-B4 eviction of idle threads from the orchestration read model, which reload from SQL on
  access (`e84335fe60`, [report](2026-11-18-read-model-eviction.md)); F-B10 did not reproduce.
- Mobile stage retirement: consent cycles are unlimited and old stages retire safely
  (`cc85ccbbfc`, [report](2026-11-18-mobile-stage-retirement.md)).
- O-1 persisted installation identity fallback for hosts without `/etc/machine-id`
  (`79a55b6136`, [report](2026-11-18-o1-installation-identity-fallback.md)).
- Late peer refusals delivered once to the coordinator thread, and `backend setup` naming the
  non-private path with the `chmod` fix (`f49e521f6e`,
  [report](2026-11-18-peer-rejection-and-setup-permissions.md)).

A live arm64 re-run of these is in progress; its report will follow.

## Needs the user

1. **Push** `dev` (or open a PR) so CI runs the new workflows, including the backend graph and
   linux-arm64 workspace-agent jobs, and check the first run of each new workflow on GitHub.
2. **Redeploy bigbud.app** so `https://bigbud.app/remote-agent.sh` serves the script (it returned
   the homepage on 17 Nov). Cloudflare Pages deploys bigbud.app from the `marketing` branch, not
   `main`. Order: open a `dev` → `main` PR and merge it, squash-merge `main` into `marketing`,
   push, then run `bun run verify:published-remote-agent-script`
   ([handoff](../validation/remote-backend-release-handoff.md)).
3. **Signing: resolved.** One Ed25519 key, id `release-2026`, signs the remote agent and backend
   graph manifests. It was set as repository secrets on `youpele52/bigbud` on 18 November 2026,
   and the only copy outside GitHub is in the user's password manager. Clients do not pin it yet
   (follow-up below).
4. **Licences: resolved** (`dc66b324a7`): real upstream licence texts are vendored and
   hash-checked, Copilot stays with its licence, and notices ship beside the agent, gateway and
   asset artifacts. The user still reads Anthropic's terms once for the Claude agent SDK
   ([handoff](../validation/remote-backend-release-handoff.md)).
5. **Provider conformance:** run the harness with real credentials per tuple
   ([commands](2026-11-18-provider-conformance-harness.md)).
6. **Phone and Tailscale:** authenticated mobile route admission needs real Tailscale Serve and a
   physical phone ([phone retest](../validation/2026-11-13-mobile-phone-retest.md)); also the
   original cellular failure.
7. **Real VPS and x86_64:** all live runs were arm64 VMs. The user has one real x86_64 VPS;
   repeat the M1–M6 checklists, mobile increment 7 and the M5 measurement matrix there. A real
   arm64 VPS run is deferred by the user (18 November 2026); arm64 stays covered by the Lima VM
   runs.
8. **D4 resolved:** default kept. The first release with backend graphs ships gnu and musl remote
   agents; the release after it drops gnu
   ([prep](2026-11-17-d4-musl-only-cutover-prep.md)).
9. **O-1 resolved:** the user chose a persisted random installation id as the fallback identity
   on machines without `/etc/machine-id`; implemented in `79a55b6136`
   ([report](2026-11-18-o1-installation-identity-fallback.md)). Reattach after a container
   restart is still refused by design.
10. **Packaged desktop app runs:** the P4 launcher gate on macOS, Linux and Windows; the
    `?backend=` window; the update UI; the Settings > Peer hosts UI; the packaged
    `bigbud://app` origin; and Windows and x86_64 P6 clients.
11. **Two physical laptops:** M2 30-minute recovery and two-laptop approval, and the P8
    two-client exit.

## Follow-ups (code and docs)

- Client trust-key pinning: clients trust the key store published with each release; pinning
  `release-2026` in the app is not done.
- Launcher rollback does not cover `Restart=no` units: a crashed new runtime is not relaunched,
  so rollback waits for the next manual start
  ([report](2026-11-18-launcher-rollback-unbootable-runtime.md), Gaps and notes). Document this
  for users.
- D4: apply the prepared gnu-drop workflow diff for the second release with backend graphs.

The unreachable legacy OpenCode synthetic-workspace path is removed (`9c142552ee`).

## Evidence

Every live run is archived under `~/DevWorld/bigbud-evidence/` with a `.sha256`, without private
keys or tokens. Reports for each milestone are in this directory, dated 17–18 November 2026.
