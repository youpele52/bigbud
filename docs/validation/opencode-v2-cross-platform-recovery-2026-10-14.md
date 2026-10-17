# OpenCode V2 cross-platform recovery audit

## Scope and current status

The requested target is managed installation and restart recovery on macOS,
Linux and Windows. **Windows storage/publication is now implemented in source;
native Windows execution and end-to-end readiness remain unverified.**
Platform candidacy must not be confused with secure publication or completed
retail semantic qualification.

| Boundary                                      | macOS                                           | Linux                                             | Windows                                                                               |
| --------------------------------------------- | ----------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Stable V2 candidate, ARM64/x64                | Implemented                                     | Implemented                                       | Implemented                                                                           |
| Platform-scoped qualification / semantic deny | Implemented                                     | Implemented                                       | Implemented                                                                           |
| Machine config namespace classification       | `/Library/Application Support/opencode`, MDM    | `/etc/opencode`                                   | `%ProgramData%\opencode`                                                              |
| Prepared host reboot evidence                 | Existing IOPlatformUUID + kernel boot UUID/time | Root-owned machine-id + real procfs boot_id/btime | Native kernel BootId + SMBIOS adapter implemented; native execution not yet validated |
| Managed file publication                      | Existing POSIX guarded path                     | Existing POSIX guarded path                       | Native retained-ancestor operations; requires `private-files=1`                       |
| Native end-to-end validation in this work     | Not ready (attempt 3 failed)                    | Not run on this Mac                               | Not run on this Mac                                                                   |

No qualification records were added. Synthetic tests do not establish retail
qualification. Runtime proofs now report the actual platform and architecture;
they no longer claim macOS ARM64 on other hosts. Qualifications and known
incompatibilities are keyed by release, platform and architecture. A pass on one
platform cannot qualify another; an exact-platform recorded failure still blocks.

## Implemented portable changes

- Finite ARM64/x64 candidates for the three supported operating systems, retaining
  canonical stable-major-V2 parsing and all other compatibility checks.
- Platform-specific machine-source detection, canonical path handling and Windows
  case-insensitive collision checks. Machine policy remains native-projected,
  read-only, and ineligible as the managed publication root. No machine files are
  read or rewritten by this classification.
- Linux recovery reads only fixed system paths. It requires root-owned,
  non-writable ancestors/files, no symlinks, actual procfs for kernel facts,
  bounded same-file reads, a valid nonzero machine ID and boot UUID, and a single
  valid boot timestamp. Uptime, environment overrides and service generations are
  not evidence. Changed time alone does not establish a reboot.
- The macOS host digest and property order are unchanged. The checkpoint schema
  additionally accepts a namespaced Windows kernel counter without changing old values.
  Existing signed checkpoints, seals and reserved receipts are not migrated or
  re-signed. The macOS parser now rejects malformed UUIDs and out-of-range times.
- Added deterministic platform/path/evidence tests and wired portable tests into
  the existing Windows and Unix CI matrix. Linux has a native read-only probe
  that skips on other operating systems. No CI run was dispatched.

## Historical Windows blockers (superseded by the implementation below)

`PluginSetup.fs.ts` deliberately rejects Windows publication. Replacing this
guard with POSIX mode checks or a path-based PowerShell ACL snapshot would not
provide equivalent security. The existing Rust `inspect_local` capability is
read-only; it now exposes directory identity snapshots as well as bounded
private-file reads, but not durable directory publication.
`Orchestration.records.ts` and `PluginSetup.publication.ts` also use
POSIX directory-open/fsync behavior that needs a Windows durability contract.

The implementation extends the existing provider-neutral native
filesystem boundary (not move orchestration into Rust):

1. **Implemented identity inspection:** `DIRECTORY` returns the exact 64-bit
   volume serial and 128-bit file ID as hex, never JavaScript numbers. It retains
   non-delete-sharing ancestor handles for the complete inspection, walks relative
   to those handles, checks ownership/DACLs/reparse points on the handles, and
   rejects files and unsafe ancestors. This is a read-only snapshot, **not** a
   lease authorizing a subsequent path-based write. Native Windows tests cover
   replacement identities, junctions and foreign modification grants.
2. Define exclusive creation, inherited ACL validation, atomic replacement and
   durable publication for signed records, staging, locks and managed entries.
   Do not repair a foreign ACL or overwrite a collision. Extend protocol and
   capability negotiation and native Windows adversarial fixtures together.
3. **Implemented native boot query:** `BOOT` reads current-process kernel
   `PROCESS_TELEMETRY_ID_INFORMATION.BootId` and an OS-provided SMBIOS system UUID.
   It bounds both buffers, rejects unavailable/placeholder/ambiguous identities,
   and derives diagnostic boot time from creation and interrupt time. TypeScript
   hashes the machine identity in a Windows-specific namespace; only a forward
   kernel counter on that same host can establish a reboot. Counter regression,
   wrap and differing identity namespaces fail closed; wall-clock changes alone
   cannot retire owners. An old helper without the negotiated capability fails
   closed. Neither a service restart nor an application-generated GUID is used.
   Native Windows same-boot/cross-helper tests are in the existing CI matrix;
   real reboot, hibernation/fast-startup and Windows ARM64 remain validation gaps.
4. Keep the old checkpoint schema/digests backward-compatible and retain all
   consent, idle, receipt and exact-owner checks. Unsupported native evidence
   must remain an explicit failure, not a fallback to guessed ownership.

`CAPABILITIES\t1` negotiates these optional read-only inspector operations. The
remote-agent workspace protobuf protocol is unchanged; these operations extend
the existing isolated `--inspect-local` line protocol. No native write capability
or publication success is advertised. The remaining Windows work spans private
issuer/artifact storage, signed records, locks and staging, not only replacement
of the final managed entry. It still needs a reviewed retained-handle publication
and durability contract; identity snapshots cannot substitute for that contract.

The obsolete macOS-ARM64-only gate in `PluginSetup.native.ts` was also removed in
favor of the shared platform candidate check. Linux and macOS x64 now reach the
existing guarded filesystem publisher; Windows still encounters its explicit
filesystem guard. A fixture regression checks this path without claiming native
Linux or Windows qualification.

Relevant references:

- <https://opencode.ai/v2/docs/config> (machine roots and source semantics)
- <https://learn.microsoft.com/en-us/windows/win32/devnotes/process_telemetry_id_information_type>
- <https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntquerysysteminformation>
- <https://github.com/boostorg/interprocess/issues/96> (Windows boot-time pitfalls)

## Live maintenance outcome

Attempt 3 made exactly one normal setup call, after observing no native foreground
or shell work. Its job `39cf491b75812bf79ace13eda14dc986` failed with the sanitized
status message “V2 activation did not verify; history/uncertain evidence was
retained.” The managed entry remained the legacy entry and the native plugin was
inactive. Both physical retirements remain sealed; the reserved receipt is
unchanged, unknown and non-replayable. The finished worker3 service was unloaded;
its result, lock and audit files remain intact. The temporary backend was not
restarted for these source changes. No further setup was attempted.

The exact activation cause is not exposed by the status response and remains to
be diagnosed without dumping private logs or retrying uncertain publication.
This cross-platform source work is not proof of a successful live installation.

## Follow-up diagnostic findings

- Read-only current config metadata for both relevant Locations contains one
  existing global document and two existing directory sources; no missing parent
  was found. Local config-control inspection passed with no explicit plugin entries.
- The signed reboot-publication candidate validated under a bundled Node probe
  without archival or native config mutation. The probe exported an immutable
  artifact from current sources, so it was not wholly read-only with respect to
  the app-private artifact store. That digest was
  `5a291030a687aab7aaa278922d0ecae54b727a527b6031c5b95cc00b777a835c`;
  it is not evidence that the artifact was installed or loaded.
- Current native plugin inventory still reports the managed plugin as failed in
  both Locations. Private error strings and configuration contents were not printed.
- Added finite stage/errno classification for future setup failures. Config scope,
  controls, plugin inventory, retained manual bootstrap, eligibility, publication,
  readiness and final source failures no longer all collapse into the same generic
  job reason. Raw SDK messages, paths and nested causes remain excluded. This
  cannot retroactively recover attempt 3's lost exception and does not authorize
  another setup attempt.
- No backend/native restart, new setup, message/tool replay, commit, push or remote
  CI dispatch occurred during this follow-up. Independent subagent review remained
  unavailable because of the configured subagent depth limit.
- Final read-only checks found native registration still at version `2.0.29`, PID
  `12872`, the managed entry still at digest
  `21ac29f98ae7173c00e30fef1d8c2db4335b2692abf65b20afa4a183e262108f`,
  and the reserved receipt byte-identical to its private backup.

## Follow-up validation

- `bun fmt`, `bun lint`, `bun typecheck`: passed. Lint reports existing workspace
  warnings; typecheck completed all nine packages.
- Focused compatibility/setup/recovery/Windows-inspector suite: **240 passed,
  8 skipped**, across 49 files. Skips include native platform/opt-in probes;
  these numbers must not be presented as Windows execution or retail qualification.
- `cargo fmt --all --check`,
  `cargo clippy --locked --workspace --all-targets -- -D warnings`,
  `cargo test --locked --workspace`: passed on macOS.
- `cargo check --locked --package bigbud-remote-agent --target x86_64-pc-windows-msvc`:
  passed, with 21 warnings in existing unrelated Windows-gated modules.
  This is cross-compilation checking, not Windows native test execution.
- Both thread-tool manifest/qualification checks and `git diff --check`: passed.
  The qualification registry still contains zero qualified/incompatible records.
- All source/test files authored or materially edited in this follow-up are under
  the 400-line limit. No remote CI was dispatched.

Next work is still required: implement and review the Windows native write/
durability contract across all storage consumers; diagnose attempt 3 using a
bounded, non-mutating reproduction or the new redacted stages; only then consider
another normal, idle-gated setup attempt. The current native plugin is not ready.

## Windows publication implementation follow-up

The previous explicit OS rejection has been replaced by negotiated native
operations, not by Node filesystem calls after an identity snapshot. The existing
isolated `--inspect-local` protocol advertises `private-files=1` and `read-lease=1`.
`BOOT` and `DIRECTORY` remain backward-compatible; old helpers fail before writes.
The remote workspace protobuf protocol and TypeScript orchestration ownership
are unchanged.

- `FS\t1` implements bounded directory inspection/enumeration, verified file reads,
  private exclusive file/directory creation, conditional same-directory publication,
  and exact-owned file removal. Mutation requests require an expected parent
  identity. Publication additionally requires the observed source and destination
  identities and SHA-256 hashes, or an explicitly absent destination.
- Native operations retain every non-delete-shared ancestor handle throughout
  validation and publication. Relative `NtCreateFile` opens reject reparse points;
  file identity, single-link status, owner and DACL checks use the opened handle.
  Newly created objects receive a protected current-user/SYSTEM/Administrators
  DACL at creation. Existing ACLs are never repaired. Public config reads permit
  foreign read grants but reject foreign data/append writes.
- The final rename uses volume-GUID paths obtained from the retained parent, not
  the original drive/path snapshot. Source/target data handles deny concurrent
  data writers and remain held through rename and post-publication verification.
  This is not a defense against a compromised same-user or administrator process;
  the signed writer lock still owns application serialization.
- Writes are at most 128 KiB, reads at most 1 MiB, inventories at most 4096 names,
  and requests/responses are bounded before decoding. A dedicated backup read
  lease is limited to one file and 512 MiB per helper and dies with its connection.
  It pins the private database and ancestors while TypeScript reads SQLite and
  prepares the checkpoint; live sidecar evidence is rejected.
- File creation flushes bytes with `FlushFileBuffers` before same-volume
  `MoveFileExW(MOVEFILE_WRITE_THROUGH)` publication; copy/delete and delayed reboot
  moves are forbidden. This uses Microsoft's documented Windows contract, **not
  a claim of POSIX directory fsync or independently tested power-loss durability**.
  Directory flushing is not faked. Exact-owned lock removal can leave a stale
  lock after a crash; that evidence is not automatically reclaimed.
- Native failures after physical issuance, lost acknowledgements and transport
  termination report uncertainty. Issued operations have a separate 30-second
  execution bound; shutdown joins the owned helper exit (with escalation) before
  releasing the physical promise. Unconfirmed exits retain ownership/capacity.
  Unknown staging and successor locks are not deleted, and no operation is replayed.
- Issuer/encryption keys, immutable artifact modules and manifest-last publication,
  signed records/checkpoints, inventory reads, publication locks, staging and the
  managed entry now use this adapter on Windows. Windows identities stay exact
  hex strings; historical numeric POSIX records/checkpoints remain accepted and
  unchanged. macOS reboot device-number adoption is not applied to Windows IDs.

References checked for the publication contract:
<https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw>
and <https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers>.

### Validation and remaining limits

- Focused suite: **246 passed, 11 skipped, 53 files**. The new native Windows tests
  are skipped on this Mac and wired into the existing Windows x64/ARM64 matrix;
  that matrix was **not dispatched**. They exercise issuer/artifact/record/managed
  publication, hash/identity conflicts, immutable collisions, ancestor pinning,
  junctions, DACL grants, backup leases and exact-owned removal.
- Host-only fixtures cover old-helper rejection, full-width identities,
  queued authority revocation, hash/acknowledgement checks and uncertain physical
  shutdown. A final focused rerun passed **15 tests** after shutdown changes.
- `bun fmt`, `bun lint` (existing warnings), and `bun typecheck` (nine packages)
  passed. Rust workspace formatting, strict clippy and tests passed on macOS.
  Windows x64 cross-compilation passed with the existing 21 unrelated warnings;
  strict cross-target clippy is not green due to unrelated Windows-gated debt.
- Server build and both manifest checks passed; the retail qualification registry
  remains empty. `git diff --check` passed. All materially edited source/test files
  remain at or below 400 lines. Independent review delegation still hits the
  configured subagent depth limit.
- Native Windows execution, Linux installation, actual reboot/hibernation/fast
  startup, power-loss tests and retail semantic qualification are outstanding.
  Source implementation plus cross-compilation does not certify those behaviors.

### Live macOS retry preparation

Before any further setup, rechecked the exact unchanged legacy managed entry and
original signed installation, the absence of a reboot-publication archive or
native staging entries, the sealed physical-recovery status, and byte-identical
reserved receipt. The old semantic outcome remains unknown and non-replayable.
Rebuilt the temporary backend with finite stage diagnostics. Revalidated its
launchd ownership, child PID relationship and unused listener, gracefully stopped
only that owned backend, and restarted the same launchd service. Native OpenCode
was not restarted or interrupted.

Created a separate attempt-4 worker with unique lock/result names; all earlier
scripts/audits are retained. Its self-check made **no setup call**, confirmed native
`2.0.29`, and derived the current artifact digest from verified current source:
`5a291030a687aab7aaa278922d0ecae54b727a527b6031c5b95cc00b777a835c`.
The worker waits for two quiet observations, rechecks consent/generation/evidence,
then allows one normal setup call. It records only finite stage/errno diagnostics
and verifies loaded artifact plus five-tool metadata in both Locations if setup
reports ready. A failed/uncertain result never triggers another refresh.

### Attempt 4 timeout diagnosis

Attempt 4 completed at `2026-10-14T21:20:01.445Z` with
`idle-deadline-no-setup`, **zero setup calls**, final foreground/shell counts 0/0,
normal process exit 0 and empty stderr. The loop required two consecutive quiet
observations five seconds apart. The final zero counts plus its `quiet < 2`
timeout branch establish a streak of one, not continuing native activity. The
deadline prevented another observation; previous sample times were not saved.
The installation and reserved receipt remained unchanged. Finished worker4 was
unloaded without removing its evidence.

Prepared attempt 5 with a boundary correction: preserve both separated quiet
observations, but allow at most 20 seconds beyond the five-minute idle deadline
when a first quiet observation has arrived. The total ten-minute bound, consent,
generation checks and normal server idle gate are unchanged. Each sample now
persists timing, counts and quiet streak; uncertainty fails closed. Eight pure
boundary assertions and a full self-check passed without setup. The current
artifact/backend digests are unchanged. This is an operational worker correction,
not a weakening of application publication checks or proof of plugin readiness.

### Attempt 5: reproduced publication stack overflow and source fix

Attempt 5 obtained two quiet samples and issued one normal setup call. Job
`eaaaaefda03f6d0edbd370d218098d88` failed at `publication` with `range-error`.
This was not an idle timeout. Worker5 exited normally and was unloaded with all
scripts/locks/results retained. A fresh metadata check found the original signed
installation still committed and byte-identical, the original managed entry
unchanged, no reboot-publication archive or staging entries, and no retained
activation/record lock files. The reserved receipt remains byte-identical,
unknown and non-replayable.

Two isolated regressions reproduced **`RangeError: Maximum call stack size
exceeded`** before the fix, without accessing native configuration:

```text
NativeCompatibility.runtime.ts:179  proof.assertCurrent -> current.operationGuard
PluginSetup.publication.ts:85       operationGuard -> shared.assertCurrent
PluginSetup.publication.ts:71       shared.assertCurrent -> publication.assertGate
publication.assertGate             -> proof.assertCurrent (cycle)
```

The signed reboot/publication test now obtains a proof from the **production**
compatibility validator, rather than only a synthetic proof with no operation
guard callback. Synthetic health/config inputs remain fixtures, not retail
qualification. It exercises sealed reboot evidence, old device-number adoption,
archival, native-entry publication in an isolated directory and unchanged reserved
receipt. Both regressions failed before the production change and pass after it.

The fix removes the recursive dynamic operation-guard invocation from proof
validation. A proof validates binding, consent revision, request scope and current
operation signal; it is not execution authority. The operation authority and
native request issuance still invoke the guard, which independently validates
the short gate/deadline. Regression coverage explicitly rejects an expired gate,
revoked consent and an aborted operation signal. No gate, ownership, idle or
publication check was removed from execution paths.

Validation after this fix: **248 passed, 11 skipped across 54 files**; `bun fmt`,
`bun lint` (existing warnings), all nine package typechecks, server build, both
manifest checks and `git diff --check` passed. No Rust source changed in this
follow-up. The generator digest and empty qualification registry are unchanged;
native Windows execution remains unverified. Changed source/test files remain
below 400 lines. Delegated clarification still fails at the subagent depth limit.

Prepared unique attempt-6 files using the bounded two-sample idle policy and
per-sample diagnostics. Only the revalidated temporary backend is being restarted
with this fix; native OpenCode is not restarted. Attempt 6 is a new normal setup
job after a demonstrated fix and unchanged publication evidence, not a replay of
attempt 5 or its unknown tool receipt. Installation readiness is still not claimed.

The rebuilt temporary backend was subsequently restarted after revalidating its
wrapper/child ownership and absence of connected clients. Its new wrapper/child
PIDs are `77197`/`77200`. An early preflight check failed before any setup call;
after confirming the listener, the full self-check passed with the unchanged
artifact digest and backend digest
`171d4c3c7170ef1ab96b45a0e5b64668eb8b3d350c2b2b2889b600fea7759382`.
Attempt 6 is ready for the host-owned idle worker, not verified installation.

### Attempt 6 succeeded; subsequent intermittent send failure

The retained attempt-6 result reports **ready** at `2026-10-14T21:49:27.338Z`
after one normal setup. Both `/Users/youpele/DevWorld` and its `bigbud` child
Location verified the active managed plugin, expected issuer/artifact and five
tools. Subsequent read-only metadata checks confirmed those same facts on native
OpenCode `2.0.29`, PID `12872`. Qualification remains absent. The signed reboot
proof remains physically retired; the original reserved receipt is byte-identical
and unknown/non-replayable. No new setup or model prompt was issued in this follow-up.

Desktop backend port **3774** logged four `sendTurnAttempt` failures at
`22:13:21`, `22:13:53`, `22:14:04`, and `22:27:11` UTC on October 14:
`V2 prior physical admission remains owned; no new turn.` This is distinct from
the twelve retirement failures logged by diagnostic backend **3773** around
`22:13:57–22:14:02`. Raw prompts, credentials and private exception bodies were
not printed.

An isolated production-runtime reproduction and two red regression tests showed
the settlement scheduling defect: terminal output was delivered while native
activity still existed; settlement correctly retained the token, but ordinary
polling then excluded the terminal/clean session forever. A later explicit send
rejected that token without refreshing settlement. A fresh guarded drain check
released it. The exact reason the original live check deferred remains unknown.

With explicit approval, the fix keeps retained terminal reservations in the same
serialized repair queue, uses exponential polling backoff capped at 30 seconds,
and rechecks guarded settlement before a new explicit send. It does not replay
the failed send. Settlement-only checks do not reread/re-emit terminal history.
After 30 seconds of unresolved settlement, normal status reports a deduplicated
error; verified drain restores readiness. Native read failures retain authority
and remain errors. Checks revalidate consent, operation cancellation, exact owner,
token, row and stream generation after asynchronous boundaries, plus exact shared
storage/directory binding, journal completion, physical-operation completion,
native drain and callback/publication drain. No timeout can force release.

The first unpinned SQLite backup exceeded its deadline and was not inspected.
A new private online backup with a pinned read snapshot completed in 10.51 seconds
and passed `PRAGMA quick_check`; only that completed copy was queried. For thread
`a9bf3c58-929b-4a76-adc9-735dc4d7c137`, its last three admissions were terminal,
the latest completed at `22:13:11.911Z`, its shared binding was verified, and its
projected error at `22:27:11.285Z` was the physical-admission rejection. The second
inspected thread had nine completed admissions and a verified binding. Both exact
native sessions were inactive at inspection; this is not retroactive proof of
their state at the original settlement check. Snapshot/evidence remain private
under the existing recovery backup directory.

**Duplicate backend investigation:** process/open-file evidence confirmed the
temporary launchd Node backend (wrapper `77197`, child `77200`, port `3773`) and
the desktop Electron backend (port `3774`) both opened `~/.bigbud/dev/state.sqlite`.
Desktop selects another free port (`backendPort.ts`) but does not thereby select
a separate state directory. Electron's single-instance lock covers desktop
instances, not the independent Node service. The inspected SQLite layer uses WAL
and transaction locks, not an exclusive application-instance ownership lease.
No new locking policy was implemented; retirement errors cannot safely be
resolved by deleting ownership records. Confirm the active UI instance before
retiring the temporary diagnostic backend.

**Validation side effect:** the normal server build wrote `dist/bin.mjs`, which
the running `dev-electron.mjs` launcher watches and uses to restart the desktop.
Desktop PID turnover was observed and its ancestor watcher was confirmed. No
explicit stop/kill/restart command was issued, but the build could trigger that
restart despite the intended no-restart boundary. This was disclosed; further
validation avoids writes to watched build output. Native OpenCode PID remained
`12872`. The first build passed; final source refinements are not claimed loaded
or live-send verified. No message test was sent to native OpenCode.

Settlement validation: both initial production-runtime regressions failed before
the fix. The expanded admission/runtime/cancellation/binding/event-hub suite
passed **259 tests across 69 files** (the initial 120-second command timed out;
the bounded longer rerun passed in 111.51 seconds). The final settlement-only
rerun passed **18 tests across three files**, including a subsequently added
queued-send/no-overlapping-drain regression. Its initial call-count assertion
included earlier setup calls on a reused spy; resetting the observation counter
before scheduling the drain fixed that test without changing production code.
Root formatting, lint (existing warnings), all nine typechecks, both manifest
checks and `git diff --check` passed. All authored source/test files are under
400 lines. No Rust source changed for this fix. Independent delegation was
unavailable at the configured subagent depth limit. No commit or push was made.
