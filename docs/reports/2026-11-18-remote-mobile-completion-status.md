# Remote and mobile completion status — 18 November 2026

## Summary

Every phase of the [remote agent plan](../plans/2026-11-13-remote-agent-manual-install-plan.md)
(P1–P8, tracked in the [remote completion plan](../plans/2026-11-17-remote-completion-plan.md))
and the [production native mobile composition](../plans/2026-11-17-production-native-mobile-composition-plan.md)
is implemented and committed on `dev`. Every live-testable part has been run on disposable Lima
Ubuntu 22.04 arm64 VMs with fixture-signed builds from `git archive` snapshots. Each live run
found defects, and every defect found has been fixed and re-run live. What remains needs real
infrastructure, credentials, hardware or a decision that only the user can provide.

Nothing has been pushed. `dev` is 52 commits ahead of `origin/dev`.

## Proven live (arm64 Lima, fixture keys)

| Area                                                                                                                                                                                                                                                                                         | Evidence                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| P6 persistent terminals: S1–S5, real prior-boot recovery, restart status, P6-7, P6-4b, P6-4c, Linux-client rows, Electron Quit/relaunch                                                                                                                                                      | [P6 acceptance](2026-11-17-remote-p6-head-acceptance.md)                                                            |
| M1 managed backend under systemd: setup, start/stop, exit 0 on stop, crash restart, crash-loop needs-repair, terminal survival, SIGTERM reaping, no-linger accounts, boot autostart 3/3                                                                                                      | [M1 acceptance](2026-11-17-m1-live-systemd-acceptance.md)                                                           |
| M2 deployment and multi-client: laptop deploy from macOS with an agent-held key, adoption, idempotent retry, hash-mismatch, laptop upload, one receipt per command, one approval answer, snapshot plus tail, relay pinning                                                                   | [M2/M3 acceptance](2026-11-18-m2-m3-live-acceptance.md)                                                             |
| M3 safe runtime updates: automatic deferral then activation, pending approval blocks, interrupting update with consent, stale consent, Rust terminal PID unchanged, disk-full and downgrade refused, failed-trial rollback, interrupted restore, manual recovery, workspace-mode reservation | [M2/M3 acceptance](2026-11-18-m2-m3-live-acceptance.md)                                                             |
| M5 measurements (1/4/8 sessions) and linux/arm64 deletion                                                                                                                                                                                                                                    | [Measurements](2026-11-18-remote-backend-measurements.md), [arm64 deletion](2026-11-18-linux-arm64-deletion-fix.md) |
| M6 / P8 peer orchestration: pairing with confirmed pin, delegation, partition recovery with one child per dispatch, coordinator restart, cancel during partition, revoke, host-key pinning, forced-command isolation, laptop-free completion, restarted workers                              | [P8 acceptance](2026-11-18-p8-live-acceptance.md)                                                                   |
| Mobile native composition: inputs, consent, activation, original-child readiness, revoke with confirmed exit and same-CAS cleanup, successor adoption, Gone path, orphan repair, evidence-based resolve                                                                                      | [Increment 7](2026-11-18-mobile-increment-7-live-acceptance.md)                                                     |

## Verified in code only (focused tests, mutation-checked)

- M4 provider provisioning and lazy optional SDKs; the conformance harness self-test (counts as no
  acceptance).
- Renderer per-backend windows, backend-scoped storage, the update UI and the peer pairing UI
  (unit and browser tests; no packaged-app run).
- Release notices, the Rust licence inventory, and the CI workflow for backend graphs (not yet
  run on GitHub Actions).
- Reproducible builds: tsdown on rolldown 1.1.5 gives byte-identical server bundles and graph
  archives; loader-region re-pins were security re-reviewed.

## Needs the user

1. **Push** `dev` (or open a PR) so CI runs the new workflows, including the backend graph and
   linux-arm64 workspace-agent jobs.
2. **Redeploy bigbud.app** so `https://bigbud.app/remote-agent.sh` serves the script (it returned
   the homepage on 17 Nov), then run `bun run verify:published-remote-agent-script`.
3. **Signing:** confirm `BIGBUD_REMOTE_AGENT_SIGNING_KEY` is an Ed25519 PKCS8 PEM and decide
   whether backend graphs share it or get their own key.
4. **Licences and redistribution:** the decisions listed in
   [the release handoff](../validation/remote-backend-release-handoff.md) (Claude agent SDK and
   Copilot CLI terms, 19 packages without licence files, notices for the agent, gateway and
   assets).
5. **Provider conformance:** run the harness with real credentials per tuple
   ([commands](2026-11-18-provider-conformance-harness.md)).
6. **Phone and Tailscale:** authenticated mobile route admission needs real Tailscale Serve and a
   physical phone ([phone retest](../validation/2026-11-13-mobile-phone-retest.md)); also the
   original cellular failure.
7. **Real VPS and x86_64:** all live runs were arm64 VMs; repeat the M1–M6 checklists on a real
   x86_64 and arm64 VPS, and the M5 measurement matrix (1 GB and 4 GB).
8. **D4 musl-only cutover timing** ([prep](2026-11-17-d4-musl-only-cutover-prep.md)).
9. **Decision O-1:** terminal reattach after a laptop crash fails on machines without
   `/etc/machine-id` (common in containers). Recommendation: a persisted random installation id
   as the fallback identity.

## Known open items (not blocking the above)

- A delegate refused before acceptance, after the tool already returned `sent-uncertain`, settles
  without a delivery to the coordinator thread.
- Remaining unbounded structures F-B1..F-B10 from the measurement report.
- Mobile consent cycles are limited to 16 stages per installation.
- A remote backend that never starts Node after an update needs the documented manual recovery.
- `backend setup` refuses with a generic reason when the trusted-keys file or directories are not
  private (0600/0700).

## Evidence

Every live run is archived under `~/DevWorld/bigbud-evidence/` with a `.sha256`, without private
keys or tokens. Reports for each milestone are in this directory, dated 17–18 November 2026.
