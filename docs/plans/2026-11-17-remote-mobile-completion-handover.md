# Remote and mobile completion handover

**Updated:** 17 November 2026
**Status:** In progress. The native lease and managed proxy have strong isolated Linux evidence; end-to-end managed activation, recovery, and deployment qualification remain open.
**Purpose:** Give the next agent a single current entry point for continuing both plans.

## Source plans and evidence

- [Remote agent installation, persistence and orchestration](2026-11-13-remote-agent-manual-install-plan.md) is the authority for remote phases P1–P8 and their acceptance requirements.
- [Reliable mobile access to desktop and VPS](2026-11-13-mobile-remote-access-plan.md) is the authority for mobile phases P1–P6.
- [Mobile full-plan requirement ledger](../validation/2026-11-14-mobile-full-plan-ledger.md) records detailed mobile requirement evidence.
- [Native Linux validation handoff](../validation/2026-11-16-native-linux-agent-handoff.md) records exact R6/R7 Linux ARM64 test commands, artifacts, hashes, and runtime results.
- [Mobile phone retest procedure](../validation/2026-11-13-mobile-phone-retest.md) records the physical-device qualification procedure.

This document summarizes the current shared state. If this summary conflicts with a phase requirement or later dated evidence in a source plan, follow the source plan and latest evidence.

## What is complete with bounded evidence

### Remote plan

- The production backend setup/status/enable/disable-boot CLI has focused tests and fresh isolated Linux account setup/enable evidence. The earlier runtime-generation provisioning failure was fixed without weakening verification.
- HTTP and relayed WebSocket authentication pass. A real terminal survived graceful backend shutdown and SIGKILL with its original shell and Rust supervisor identity; reconnection delivered fresh output and stale client generations could not close the current terminal.
- Remote callback port reservation now uses the actual bound port. The two-account VM test passed authentication, RPC, distinct callback ports, and one-start/no-retry checks.
- The managed native proxy and TypeScript lease-channel acquisition have bounded review and configured server type evidence. The native proxy checks the connected peer and designated Rust unit before forwarding private frames.
- Frozen native R6 passed 31 Rust tests across 7 Linux ARM64 cases. R7 passed 34 tests across 8 cases, adding 3 real-socket/refusal proxy cases. Both used a same-build native monitor, isolated transient units, private networking, and protected home directories. Exact evidence and reproduction are in the native Linux handoff above.

### Mobile plan

- Existing-host recovery, command delivery and credential renewal have bounded focused/browser evidence. Synthetic multi-host switching, UI comparison, accessibility, reader position, drawer, keyboard viewport, and component presentation work have substantial accepted evidence in the mobile ledger.
- Signed optional artifact production/extraction and same-CAS file publication have bounded test and Linux evidence.
- The mobile asset receipt producer and native ownership/CAS cleanup model have bounded review. The client requires the negotiated native lease capability before arming a new attempt.
- Mobile preparation now requires the actual managed channel and private-key-derived capability signer. The caller cannot inject a signer. Its frozen source passed 44 focused tests, formatting/static checks, and the coordinated configured server type check.
- The readiness parser draft has its own focused tests and strict lint evidence, but remains a draft until integrated with native readiness and owner lifecycle.

These are scoped completions, not phase exits or production deployment acceptance.

## Current position

The remote native lease guard, receipt custody, and managed proxy have passed isolated Linux ARM64 tests. The managed proxy/channel code is source-reviewed and typechecked. The two-account callback proof passed, but intentional service stop currently reports exit 130 and systemd `Result=exit-code`; keep this limitation visible.

Mobile signer integration and preparation are implemented and reviewed, but no production native Start/readiness path is wired. Native process spawn/custody does not prove the mobile gateway owns its listening socket or is ready to serve. The current readiness parser is off-checkout and does not create readiness authority. No complete phone-to-VPS conversation has been accepted.

There is no production VPS deployment, release signing/publication, live provider conformance run, or physical phone qualification in the evidence summarized here. Do not report either plan complete or infer completion percentages from test counts.

## Remaining work by plan

### Remote plan: P1–P8

1. **P1–P4 installation and host lifecycle:** preserve prior bounded CLI, installer, account service, and recovery evidence. Resolve the exit-130 intentional-stop behavior with a narrow managed-service shutdown policy and tests proving unexpected interrupts/errors still fail. Complete any remaining PAM logout/reboot and platform-specific acceptance called out by the remote plan.
2. **P5 providers:** run the required live conformance rows for all supported providers with authorized credentials and disposable targets. Existing bridge tests and mocks do not count as live provider acceptance.
3. **P6 terminal lifecycle:** finish the plan’s inventory, detach-versus-stop, diagnostics, bounded logging, disconnect/restart, and cross-client acceptance. Distinguish the completed controlled VM PTY proof from the remaining real-host cases.
4. **P7 packaging and production backend:** complete the positive managed-service acquisition on a fresh immutable graph and fresh account using the actual owner/SQL context and managed channel. Finish full backend dependency/native closure, representative workload and resource measurements, update/drain/rollback, and fault recovery. Keep the custom Rust build-std result separate from official release toolchain certification.
5. **P8 orchestration:** implement and validate durable scoped peer dispatch, follow, cancellation, and cross-host recovery on the P7 ownership and recovery model.
6. **Delivery/platform gates:** complete pinned installer/script delivery and applicable Windows/native x64/OS-floor checks. Any release, public deployment, or provider credential use remains subject to the plan’s authorization boundaries.

### Mobile plan: P1–P6

1. **P1:** retest the original cellular failure on a physical phone, including sleeping-host behavior.
2. **P2:** integrate the native gateway Start/readiness lifecycle. The monitor must correlate an original-child bind/readiness event to the exact launch and loopback socket before readiness can reach the app. A public descriptor probe alone is insufficient. Resolve timeout budgeting without converting uncertain starts into false failures or successes.
3. **P3:** wire the accepted preparation, managed channel, native worker, neutral listener, and shared owner through an opaque lifetime proof. Keep production activation unavailable until all proof inputs are present. Then prove a real direct VPS turn with the laptop off and a second client.
4. **P4:** complete native socket receipt, stale-socket recovery and attach. Resume must bind the original socket inode and old controller death; unlink only the exact stale inode after `ECONNREFUSED`; verify the newly attached socket before readiness. Complete consent-off cleanup and recovery against the canonical CAS journal.
5. **P5:** complete phone tests for Wi-Fi/cellular changes, 30-minute suspension, keyboard, rotation, screen reader, navigation, and full-shell geometry. Browser capture counts do not replace device acceptance.
6. **P6:** finish production artifact compatibility, update rollout and rollback evidence, installed Serve behavior, and operator/user documentation.

## Immediate next sequence

1. Integrate the native original-child readiness event with a bounded response correlated to the exact lease Start. Use the existing gateway’s post-bind ready output only if the native monitor validates it from the original child and cannot confuse an unrelated listener for that child.
2. Run the configured server type check for any new readiness/client/identity source as one exact frozen union; run focused tests/static checks for changed files and affected packages.
3. On a fresh immutable graph/account, prove managed native prepare → Start → original-child readiness → authenticated route admission → consent revocation → confirmed native exit → same-CAS cleanup. Record every source and artifact hash. Preserve unknown outcomes as uncertain.
4. Add original socket receipt and successor attach/recovery, then prove controller crash/restart and laptop-independent VPS operation.
5. Continue provider, P8, physical phone, update/rollback, and platform gates from the two source plans. Update those plans and the mobile ledger with bounded results as each gate closes.

## Handoff rules

- Read the source plans, this handoff, and the exact latest packet before editing. Keep existing frozen manifests and VM evidence immutable.
- Preserve dirty workspace changes from other contributors. Coordinate ownership before editing server startup, identity, listener, native protocol, or CAS lifecycle seams.
- Use new source revisions for changes; never relabel historical R5/R6/R7 evidence as proof for later code.
- Use fresh accounts and immutable graphs for managed activation. Do not hand-edit pinned configs, signing state, or account registries.
- Follow repository `AGENTS.md`: source/test files must stay at or below 400 lines; use explicit focused formatter/linter/type/test invocations; never run `bun test`; obtain approval before broad workspace checks and a fresh approval before each commit/push.
- Keep completion claims tied to exact evidence. Report failures, skipped checks, synthetic fixtures, and unqualified platform/provider rows explicitly.
