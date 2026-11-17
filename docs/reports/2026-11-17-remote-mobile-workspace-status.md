# Remote and mobile workspace status — 17 November 2026

## Decision

Superseded by the afternoon update below: the remote P6 inputs were present after all, and the
P6 core rows now pass. Neither the remote plan nor the mobile plan is complete.

## Afternoon update — 17 November 2026

The morning entry's statement that the P6 re-entry inputs were absent was wrong. That session's
`/tmp` view was sandboxed. `/tmp/bigbud-p6-superset-final.sha256` exists and hashes to the
accepted `6fd78f61…22f6`, and the snapshot `/tmp/bigbud-p6val-20261114165515/src` is present.
The coordinating agents (chief, validator, reviewers) no longer exist, so this session ran the
steps directly. All changes below are uncommitted on `dev`.

**Evidence durability.** `/tmp` is cleared on reboot. The `/tmp/bigbud-*` evidence, excluding
rebuildable build output, is archived and verified at
`~/DevWorld/bigbud-evidence/tmp-bigbud-evidence-2026-11-17.tar.zst` (2.4 GB, 294,424 files,
SHA-256 sidecar and restore README beside it). All 9 preserved validation containers and the
s3b/h1/h2/h1c/h2c hosts no longer exist in Docker; their exported snapshots remain in `/tmp`
and in the archive.

**Remote P6 core: S1–S5 pass, with qualifications.**

- corr3 = corr2 plus the three accepted MR-epoch files (manifest `f27d8876…571e`, 134 paths) at
  `/tmp/bigbud-p6val-corr3-20261117112130`. Configured server types exit 0; 64 focused MR tests
  pass; server dist `21455533…9d5`; agent `0bde98f8` and install source `59469fc0` reused.
- S4 H1 (supervisor kill -9, same boot): **PASS.** The failed install's admission is retired as
  `rejected`/`SUPERVISOR_DEAD`; managed restart reaches ready with a new epoch in 4.95 s; old
  attach is bounded; no create or replay. This closes F-P6C-MR-ADMISSION for the same-boot case.
- S4 H2 (docker restart): unchanged container fixture limit, recorded as not prior-boot proof.
  Host `bigbud-p6corr3-h2d` kept as evidence.
- S4 H2 prior-boot (user-approved Lima 2.3.0 VM, Ubuntu 22.04 arm64, no host mounts, SSH only on
  `127.0.0.1:33111`): **PASS.** A real guest reboot changed `boot_id` away from `launch.boot`
  with no `launch.exit`. The CLI install exits 4 and its admission is retired; managed restart
  reaches ready in 5.03 s with a new epoch through the prior-boot-dead branch; old attach is
  refused without create or replay; pins and the outside control process survive. The VM was
  deleted afterwards. Evidence: `/tmp/bigbud-p6val-prior-20261117114953/`.
- Full record: §45 and §46 of `/tmp/bigbud-remote-validation-current-report.md`. The corr3,
  prior-boot and report files are also archived in
  `~/DevWorld/bigbud-evidence/tmp-bigbud-evidence-2026-11-17-p6-afternoon.tar.zst`.
- Still open: the Linux-client subset, and a re-run on a build from current `dev` before release
  (27 of the 134 validated paths have since changed on `dev`, including protocol files). The
  status read-model defect reproduced in the corr3 build; it is fixed in `dev` (below).

**Remote follow-ups fixed in source (focused checks only).**

- Intentional managed-service stop now exits 0 instead of 130 (`apps/server/src/bin.ts`,
  `bin.serviceTeardown.ts`). Unexpected interrupts, failures and mixed causes still exit nonzero.
- Five restart tests that failed on `dev` since `38bef74f43` were stale fixtures: their fake
  attach replies lacked the `requestId`/`ptyId` echo that the WARM13 identity check requires.
  Only the fixtures changed; no assertion was weakened.
- F-P6C-MR-STATUS-READMODEL (found in the corr3 run): restart status and same-request retry
  were refused after a backend restart for a project without active threads, because the check
  read the in-memory read model. `wsRemoteAgentRestart.ts` now validates against the durable
  project projection, with a new five-case test.
- Checks: server types exit 0; 251/251 tests across 33 remote-agent/restart/reconnect files;
  explicit-path oxfmt/oxlint clean.

**Mobile P4: native readiness receipt and successor recovery (Rust only).**

- `crates/bigbud-remote-agent/src/service_lease/{receipt,recovery}/` and `owner.receipt.rs`
  add a durable, private, bounded readiness receipt written only after original-child readiness
  is proven. It records binding lineage, controller and child identity, gateway listener inode
  and the upstream `remote-mobile.sock` path and inode. Failure to persist yields `Uncertain`.
- A successor uses the existing Resume twice. The first proves prior-controller death,
  classifies the gateway as live, gone or uncertain, unlinks the stale upstream socket only on
  `ECONNREFUSED` after an exact-inode recheck, and returns the new `"attaching"` state. The
  second verifies the newly sealed socket and the still-live gateway before `"spawned"`.
  Consent-off still flows only through the canonical registry guard and confirmed exit.
- Checks: affected-crate Clippy (host and `x86_64-unknown-linux-gnu`) pass; 86 focused lib tests
  pass on macOS; on a disposable aarch64 Linux container 338 crate lib tests, 5 recovery
  integration tests and the ignored real-gateway Start → stale socket → attaching → spawned →
  revoke test pass. One unrelated `inspect_local` test failed in that container, probably
  because it ran as root; not investigated.
- TS side: the protocol golden has a `lease_resumed_attaching` frame; the service-lease client
  returns `live` or `attaching` from Resume and adds `attach()` for Resume #2 behind a separate
  bootstrap-only token. `mobileGatewayActivation.successor*.ts` implements the two-step sequence
  with canonical-journal consent checks before Resume, before bind, after seal and before ready;
  legacy `spawned`, refusals and uncertain native results never report ready. The upstream
  socket helper was extracted from `mobileGatewayListener.ts` without behaviour change.
  Checks: 99 focused tests across 19 files, server types exit 0, protocol golden test and Clippy.
- Not yet done: no production native Start/readiness composition exists, so the successor
  sequence is a tested port-based module that nothing calls yet (the same P2/P3 gap). After
  that: live backend crash/restart proof on a fresh Linux account, the Gone variant, and x86_64
  and ARM64 qualification runs.

**Next steps.**

1. Commit the above after review (user approval required).
2. Build the production native Start/readiness composition (mobile P2/P3, remote P7) and call
   the successor sequence from it; then prove it with a real backend crash/restart on a fresh
   Linux account.
3. Run the prepared positive managed-acquisition packet
   (`/tmp/bigbud-p7-managed-channel-20261117`) on a fresh account after rebuilding its native
   input from current source; it currently pins the pre-readiness R7 binary.
4. Run the Linux-client subset; then rebuild from `dev` and re-run the affected P6 rows before
   any release. Lima is installed and can host disposable full VMs for this.
5. Physical phone retest when the user is available.

Disk housekeeping: following the user's cleanup runbook safe tier, 33 Cargo-tagged `target/`
directories inside `/tmp/bigbud-*` packets were deleted (free space 15 → 23 GiB). Evidence,
snapshots, the corr3 tree and the R6/R7 runner were kept.

## Scope and workspace

This report records the status after rereading:

- [Remote and mobile completion handover](../plans/2026-11-17-remote-mobile-completion-handover.md)
- [Remote agent manual install plan](../plans/2026-11-13-remote-agent-manual-install-plan.md)
- [Mobile remote access plan](../plans/2026-11-13-mobile-remote-access-plan.md)
- [Mobile full-plan requirement ledger](../validation/2026-11-14-mobile-full-plan-ledger.md)

The worktree is on `dev`. No background validation or implementation job is running. Commit and
push state is reflected by the repository history rather than treated as a plan acceptance gate.

## Work completed with bounded evidence

These are implemented or accepted slices. They are not blanket phase exits; the detailed
requirement evidence and qualifications remain in the linked plans and ledger.

### Remote plan

- **P1–P2 install foundations:** failure diagnostics/preflight and Linux musl target support were
  implemented, with the plan's compatibility and platform limits retained.
- **P3–P5 install and capability path:** trusted pre-placed artifact adoption, version-pinned
  install/update flows, backend-owned CLI/status operations, and agent install/status capabilities
  have bounded implementation and review evidence. Applicable Linux/macOS install evidence is
  recorded; Windows execution/publication is not inferred.
- **Remote terminal lifecycle:** authentication, real terminal survival across graceful backend
  shutdown and SIGKILL, reconnect, stale-generation fencing, callback port reservation, and
  two-account callback behavior have bounded live evidence. Native Linux R6/R7 ARM64 validation
  passed the recorded 31/34 test sets across 7/8 cases; exact procedures are in the native Linux
  validation handoff.
- **P6 source and bounded live slices:** inventory, attach-only identity fencing, Detach/Stop,
  diagnostics, bounded client behavior and recovery were implemented and reviewed in frozen
  increments. Latest validator accounting credits S1/S2/S5 PASS on agent `0bde98f8` and server
  `38e97147`; the corrected warm-attach source/check slice is accepted. These results do not close
  remaining P6 live rows.
- **Mobile-related remote prerequisites:** managed native lease/proxy, capability-gated channel,
  callback handling, and the mobile readiness prototype described below have isolated Linux or
  source evidence. They do not establish a production remote composition or mobile deployment.

### Mobile plan

- **P1 local diagnostics:** host doctor, bounded phone diagnostics, LAN-only origin labeling and
  stale Serve mapping handling are implemented. The original cellular failure still lacks physical
  reproduction and retest.
- **P2 gateway prototype/security:** the Rust gateway's narrow route allowlist, hostile-header
  rejection, authenticated upstream, explicit bounds, throttling, revocation/redaction and no
  durable mutation queue have bounded tests. Desktop gateway composition has isolated development
  evidence. Signed metadata/preparation, artifact production/extraction and same-CAS publication
  have focused Linux/source evidence.
- **P2 readiness added in this workspace:** native Linux Start waits for the gateway's bounded
  post-bind event and verifies that the loopback listening socket belongs to the original child.
  Focused Rust tests, the real gateway x86_64 integration, affected-crate Clippy/formatting and
  independent read-only review passed. This is not production activation or a P2 exit.
- **P3 client/authority slices:** owner-socket pairing issuance, guarded authority/session records,
  descriptor admission, scope enforcement and actual-App synthetic pairing/switching/isolation
  have accepted bounded evidence. Production runtime authority, real VPS pairing, direct VPS turns
  and second-client observation remain absent.
- **P4 existing-host reliability:** same-ID receipts, no silent replay, bounded reconnect, caught-up
  state, recovery, decision/draft handling and synthetic host isolation have local acceptance.
  Multi-host visibility/online browser recovery is accepted. This does not prove physical network
  transitions or native gateway socket successor recovery.
- **P5 presentation/accessibility slices:** shared UI extraction, typography/status semantics,
  loader and reader/drawer corrections, host controls and synthetic visual/accessibility matrices
  have bounded acceptance. The 180-capture synthetic matrix is not full desktop parity or physical
  device acceptance.
- **P6 packaging slices:** signed optional metadata/preparation, producer/extractor, private file
  publication and durable launch/exit reconciliation have bounded focused and Linux evidence.
  Production gateway ownership, safe history retirement, update/rollback and release remain open.

## Remaining work by phase

| Plan / phase | Remaining work                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remote P1–P4 | Complete outstanding PAM logout/reboot and platform-specific acceptance; resolve intentional service-stop exit 130 narrowly while retaining failure behavior for unexpected exits; close Windows/native client and publication gates.                                                                                                                                                           |
| Remote P5    | Run authorized live conformance for all supported providers on disposable targets. Mocks and bridge tests are not live provider acceptance.                                                                                                                                                                                                                                                     |
| Remote P6    | Complete affected new-artifact S3/S4 live acceptance; corrected Stop live acceptance; actual prior-boot proof; manual same-observer retry; expanded F-P6-INPUT; verified-death/new-epoch recovery; cold-owner attach/hang; replay-gap presentation; ProcessRequest queue stimulus; then the separately released Linux-client subset. Preserve the plan's incident and isolation qualifications. |
| Remote P7    | Do not begin production source mutation until explicit P6 acceptance and exact seam ownership. Then complete remote authority/composition, independent lifecycle and Rust terminal ownership, authenticated multi-client transport, workspace/update safety, nine-provider provisioning/conformance, resource measurements, and release handoff.                                                |
| Remote P8    | After P7, implement durable authenticated peer dispatch/follow/cancellation and cross-host recovery with multi-VPS/two-client fault evidence.                                                                                                                                                                                                                                                   |
| Mobile P1    | Capture and retest the original cellular failure on a physical phone; verify Wi-Fi/cellular, sleeping-host, Tailscale/ACL/TLS/Serve behavior.                                                                                                                                                                                                                                                   |
| Mobile P2    | Complete hosted/private browser policy and installed Serve acceptance; Windows/native x86_64 execution and reproducible resource measurements; production lifecycle/packaging integration; fresh immutable graph/account proof from managed prepare through readiness, authenticated route, consent revocation, confirmed exit and same-CAS cleanup.                                            |
| Mobile P3    | Wait for production P7 authority/lifecycle handoff, then complete production composition, real SSH/VPS pairing, compatibility/isolation and a direct VPS turn with laptop off plus a second authorized client.                                                                                                                                                                                  |
| Mobile P4    | Coordinate ownership of shared native/server seams; implement durable socket receipt and successor attach/recovery bound to attempt, authority and CAS; prove prior controller death, refusal, exact-inode cleanup, new readiness and same-journal consent-off cleanup. Then run physical Wi-Fi/cellular, restart, revocation, two-client and 30-minute suspension acceptance.                  |
| Mobile P5    | Complete full desktop/mobile screenshot comparison at required sizes/orientations/themes/states, physical keyboard/rotation/screen-reader checks and P3-dependent host controls.                                                                                                                                                                                                                |
| Mobile P6    | Finish production artifact compatibility, optional install/update lifecycle, active-turn-safe rollout, rollback, installed Serve behavior, platform matrix and operator/user documentation; execute only after prerequisite proof gates and release authority.                                                                                                                                  |

For full mobile requirement-by-requirement status, including completed subrequirements and their
specific residual gaps, use the linked [mobile ledger](../validation/2026-11-14-mobile-full-plan-ledger.md).
For remote source freezes, historic failures, validator rows, exact artifact identities and
acceptance conditions, use the late checkpoints in the [remote plan](../plans/2026-11-13-remote-agent-manual-install-plan.md).

## Mobile plan status

### P2: original-child readiness prototype

The Linux service-lease monitor now waits for the mobile gateway's existing post-bind stdout
readiness event before acknowledging Start. The managed bridge requires one IPv4 loopback
`--listen` argument. The monitor bounds readiness collection and verifies that the matching
listening socket inode is held by the original child. This prevents an unrelated process from
satisfying the readiness check.

Recorded focused evidence:

- Seven readiness unit tests; service-lease lifecycle (6); durable-off guard (2); protocol
  golden (1); proxy (3); and detached asset custody (1) passed.
- The ignored same-build Linux x86_64 integration using the actual `bigbud-mobile-gateway`
  passed Start/readiness/revoke.
- Affected-crate Clippy and Rust formatting checks passed. The changed Rust files are within
  the repository's 400-line limit. Independent read-only review reported no blocking findings.

This is a Linux x86_64 prototype result. It does not establish ARM64 qualification, configured
server types, production managed activation, full P2 exit, or successor socket recovery.

### P4: successor socket recovery

The existing private socket helper has conservative stale-socket handling, but mobile listener
activation currently refuses an existing socket. Existing cleanup evidence covers waiting for
the original child to exit before removing its socket and matching CAS pin. The original-child
readiness proof is not yet a durable receipt that a successor can use.

The next missing increment is a receipt tied to the attempt, authority, and CAS lineage, followed
by successor recovery that proves prior-controller death, confirms `ECONNREFUSED`, rechecks the
exact inode before unlink, attaches the successor, and verifies the new socket before readiness.
Consent-off cleanup must remain tied to the same canonical journal. These native and server
listener/CAS seams are shared and remote-owned in the handover. No owner assignment for this
increment is recorded, so this report does not claim that implementation has started.

Physical phone/network transitions, Windows/native x86_64 execution, and the other device and
release gates in the mobile plan remain open.

## Remote plan status

Remote P6 remains open. The plan identifies the required accepted final95 manifest at
`/tmp/bigbud-p6-superset-final.sha256` with digest
`6fd78f6184c6d3cbb6bcddc29729606cf00cb30be4287203fc9d339d927222f6`, and the accepted source
snapshot at `/tmp/bigbud-p6val-20261114165515/src`. The validator must also release the corrected
artifacts and fresh isolated targets for the affected live rows.

The P6 re-entry check searched accessible `/tmp` for these and related validator inputs and found
no matching files. Their absence here does not establish whether they are elsewhere, were removed,
or were never mounted into this environment. The plan requires exact snapshot/artifact identity,
fresh target isolation, and validator release; the current checkout is not a substitute.

Latest plan status leaves affected new-artifact S3/S4, corrected-Stop live acceptance, actual
prior-boot recovery, the separately gated Linux-client subset, and other listed P6 rows open.
Production P7 remains gated on P6 acceptance. No duplicate previously accepted P6 rows were run.

## Next steps

1. Continue only mobile work with a clear mobile-owned scope while ownership is coordinated for
   the shared native/server lifecycle seams.
2. For P4, obtain an explicit seam assignment, then implement and validate the durable receipt and
   successor recovery against the canonical CAS journal with real Linux controller-crash/restart
   evidence.
3. Resume remote P6 only when the accepted snapshot, corrected artifact identities, isolated
   targets, and sole-validator release are present and verified.
4. Keep phone, platform, provider, packaging, update/rollback, and release gates separate from
   source-level or synthetic test evidence. Do not report either plan complete based on focused
   test counts.

## Check scope

The readiness change was validated with focused Rust commands:

- `cargo test --locked -p bigbud-remote-agent --lib service_lease:: -- --test-threads=1`:
  27 passed; 2 intentionally ignored.
- `cargo test --locked -p bigbud-remote-agent --test service_lease -- --test-threads=1`:
  6 passed.
- `cargo test --locked -p bigbud-remote-agent --test service_lease_guard -- --test-threads=1`:
  2 passed.
- The ignored `service_lease_readiness` real-gateway Start/revoke test passed when run outside
  the restricted process sandbox. Its first sandbox run failed with `EPERM` under seccomp; the
  focused retry passed.
- `cargo clippy --locked -p bigbud-remote-agent --all-targets -- -D warnings`, explicit Rust
  formatting, and the 400-line checks passed.

The report and handover pass focused Markdown formatting, local-link, and whitespace checks.
No workspace-wide validation or remote P6 live acceptance was performed.
