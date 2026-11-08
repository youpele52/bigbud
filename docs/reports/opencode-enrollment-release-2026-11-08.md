# OpenCode enrollment-release recovery — 2026-11-08

**Original-profile recovery and real-model verification now pass with the fixed backend.** Both original owners are durably settled, bootstrap v4 is committed and ready, and first/follow-up/backend-restart model turns passed with all 12,832 baseline messages unchanged. The native service was not restarted; the packaged app was reopened afterward. The successful run is `~/.bigbud/backups/opencode-recovery-20261108-015446/`. The subsequent packaged build and user confirmation are recorded at the end of this report.

The initial enrollment failure was a **local request-scope mismatch before native activity dispatch**, not a rejected detach acknowledgement. The fixes preserve proof checks and original-owner cleanup restrictions. The chronological investigation and additional blockers are recorded below.

## Plan and scope

1. Read repository instructions, the November 7 investigation/handoff, and the latest run's `result.json`, `failure-first.json`, `setup-latest.json`, and `backend-first.log`.
2. Review the existing uncommitted recovery implementation; trace signed owners, native identity and the failed cleanup stage without changing live state.
3. Reproduce with the production compatibility verifier, fix scope composition, and test successful recovery and refusal paths on isolated state.
4. Validate copied runner components in fresh disposable directories; run only focused checks and document remaining verification.

These steps were completed. Existing recovery, identity-revalidation, event-hint and model-selection work was preserved. The initial enrollment-scope patch changed two runtime files and added three source/test files; the subsequent archive-reader changes are recorded below. No native plugin template or signed compatibility descriptor changed in this continuation.

## Evidence and blocking owners

Initial failure run: `~/.bigbud/backups/opencode-recovery-20261108-005420/`. Its two history audits passed: **12,823 original messages, none missing or changed**. Later approved runs and audits are recorded below.

At initial inspection, the backup and current enrollment/retirement/installation record signatures were verified with the issuer's public key, derived without printing the private key. Enrollment owner states then were:

| Owner prefix    | Location            | Retained state                                    |
| --------------- | ------------------- | ------------------------------------------------- |
| `f92895db26e3…` | `~/Documents`       | Revoked, heartbeat pending, retirement `retiring` |
| `f7904ca05199…` | `~/DevWorld/bigbud` | Active, heartbeat pending, no retirement          |
| `f6af76b33604…` | `~/Documents`       | Already settled; not a blocker                    |

The Node inventory reconstruction selects `f92895db26e3…` first (`enrollments/92a7b9e0…`), ahead of `f7904ca05199…` (`d217d55b…`). The failed run did not log an owner identifier, so this first-owner attribution is reconstructed from the unchanged inventory and code, not a direct per-owner trace. Both unsettled owners independently block replacement.

### Exact failure chain

1. The prior device-number recovery can complete metadata-only identity revalidation. Its `freshAuthority` call leaves `currentProof` populated in the activation transaction.
2. Upgrade publication preparation invokes registration-wide dead-backend retirement. Publication's operation guard invokes `currentProof.assertCurrent()`.
3. `runV2Cleanup` previously copied that guard into a new cleanup context, whose permit revision is `-1` rather than the execution permit revision.
4. `v2Request("dead-backend session.active", …)` invokes the copied guard **before** calling the native client. The production proof rejects cleanup intent/revision as an execution-scope mismatch.
5. At 00:56:09.570 the log reports `kind: guard`, no abort flags, and `V2 native compatibility proof lost its consent/transport scope.` The recovery wrapper converts it to the generic release error. Neither `inspect` nor `detach` is reached by this attempt, so there is no detach acknowledgement to evaluate.

The earlier recovery fixture's synthetic proof checked only the ambient permit, not production intent/revision compatibility. Thus it could pass while this composition failed.

### Alternative causes

- **Native rejection:** not the recorded cause; dispatch is stopped locally. New tests also verify refusal on native failures/HTTP 404 without manufacturing settlement.
- **Missing/stale plugin:** read-only `info` at both owner locations returned the original issuer-scoped artifact `42983fb3…`, bootstrap v3, enrollment protocol v2. It is stale for v4 admission, but present and responding. An initially empty Documents plugin inventory alone was not proof of absence; the location's read-only RPC subsequently succeeded.
- **Wrong service identity:** the observed current registration and `/api/info` agree on OpenCode **2.2.6 / PID 41478**. Its registration-path storage identity is `efb8f090…`, matching the retained owners. This is current corroboration, not a claim that today's reads independently reconstruct the service identity at every earlier instant. Older owner transport generations are expected after a service restart and are not storage mismatch proof.
- **Incompatible retirement protocol:** the archived v3 registry supports signed `inspect`/`detach` with the six-field acknowledgement used by current validators. More strongly, current-code signed, read-only `inspect` requests for all three exact original owners succeeded against the loaded v3 plugin and passed strict lease-inspection validation: each returned `missing`, revision/expiry `0/0`. No detach was sent. Registry absence is inspection evidence only, **not** physical settlement or permission to bypass retirement.

Read-only API responses were JSON, retrieved using `curl`; credentials and signed request bodies were not printed or saved in diagnostics. No native reload, restart, prompt, enroll, renew or detach was performed against the live service.

## Changes and safety

- [Client.guard.ts](../../apps/server/src/provider/Layers/OpencodeV2/Client.guard.ts): re-enter the captured parent context **only for the synchronous inherited guard**. Check its permit, operation signal and exact transport; restore cleanup context before any request executes. Cleanup retains revision `-1`, original-session routes and signed original-owner RPC wire checks. The compatibility proof still rejects direct use in cleanup; no proof exception was added.
- [Orchestration.enrollment.deadBackend.ts](../../apps/server/src/provider/Layers/OpencodeV2/Orchestration.enrollment.deadBackend.ts): retain the original cause and add a safe owner prefix, fixed release-stage label and existing sanitized failure suffix. Failures can now distinguish native activity, inspection, detach issuance and acknowledgement validation without exposing callbacks, credentials or signed payloads.
- [Cleanup regressions](../../apps/server/src/provider/Layers/OpencodeV2/Client.guard.cleanup.test.ts) and [composed recovery regressions](../../apps/server/src/provider/Layers/OpencodeV2/PluginSetup.activation.recovery.proof.test.ts) use the production proof verifier. The [isolated fixture](../../apps/server/src/provider/Layers/OpencodeV2/PluginSetup.activation.recovery.proof.fixture.ts) uses real signed plugin handlers with synthetic native HTTP/state, two retained v3 owners, pending heartbeats, partial retirement and both unchanged/renumbered installation identities.

Successful fixture recovery verifies durable settlement, two exact detach calls, unchanged signed enrollment inventory, v4 publication and no native create/update/prompt. Refusal coverage includes revoked consent, expired guard, cancellation, wrong transport, lost generation/lock, active native work, live backend, missing plugin/native errors and malformed/wrong-owner acknowledgements. Existing tests cover foreign host/storage, receipt fencing, uncertain receipts, crashes, delayed physical completion and cancellation. No record deletion, signature rewriting, ownership bypass or prompt replay was introduced.

## Validation

- Before the fix: **2 regression failures / 4 passes** in `Client.guard.cleanup.test.ts`, reproducing the same production scope-guard message before activity dispatch.
- Final focused Vitest run: **15 files / 65 tests passed**. Scope: new cleanup/production-proof recovery tests, existing recovery transaction/restart/deadline/crash tests, consent and native-proof guards, RPC/acknowledgement guards, dead-backend lock/machine/fence tests and foreign-owner checks.
- Server package `bun run --cwd apps/server typecheck`: passed; existing Effect advisory messages remain. No workspace-wide checks were run.
- Explicit Oxc formatting/lint and direct 400-line checks cover only this continuation's five source/test files. Documentation formatting/local-link checks cover this report.
- One lint invocation mixing repository and external fixture paths crashed inside Oxc's ignore-path handling. Separate explicit-path runs from each directory passed (five repository files and two external scripts, zero warnings/errors); no code rule was disabled.

### Isolated runner validation

Fresh retained output directory:

`$TMPDIR/opencode/opencode-enrollment-release-<run>/`

Copies of the corrected runner's safe helpers/verifier/tests were used; `recover.py` was neither copied nor launched. Source hashes are in `source-manifest.json`; original runner/run directories were not modified.

Final comparisons confirmed all nine original runner scripts still match those recorded hashes. All three live enrollment files and both retirement files remain byte-identical to the latest pre-run backup. The packaged app, its backend and the native service remained alive at their observed PIDs 36613, 36975 and 41478.

- **7 Python safety/preflight tests and 5 Node connection/fatal-error tests passed.**
- `isolatedVerifier.mjs` exercised the unchanged verifier against a loopback synthetic WebSocket service and disposable SQLite data: successful first/follow-up/restart-labelled verifier invocations, setup refusal before any prompt, and turn refusal. All **five process outcomes** matched expectations; prompts were not retried, original fixture rows remained unchanged, and saved failure evidence excluded the token. `isolated-result.json` explicitly labels these results synthetic. The restart-labelled invocation is not a real backend/native-service restart.
- `native-read-only.json` retains the safe native inspection results described above. It is not upgrade-completion evidence.

The runner's app-shutdown/backend-supervision path was **not executed**. No new full backend/native/model recovery run is claimed. The server distribution/packaged app was not rebuilt or replaced, so the running app does not acquire this source fix automatically.

## Approval boundary before native continuation

Original-owner detach/settlement, committed original-profile bootstrap v4, and real-model first/follow-up/restart turns still require a separate controlled run. Before any action closing the packaged app or interrupting its backend/native service, explain the exact action and obtain fresh explicit approval. A future runner must use fresh backups, token/output directories, the real profile lock, strict all-message audits, and a freshly built backend containing this fix. Do not run another writer against the live original profile. No commit or push was performed.

## Approved original-profile continuation

After explicit approval, a fixed server was built and a fresh run prepared at `~/.bigbud/backups/opencode-recovery-20261108-012701/`. The initial extra online bigbud database copy exhausted disk space before any app closure; only that new, incomplete copy and its journal were removed. Previous backups and original records were untouched. The native database is approximately 10.3 GiB, so a full additional physical copy would not fit. A tested read-only, single-transaction logical export preserved all 30 native tables in `native-history-before.sql.gz` (4,345,416,137 bytes), with schema/row counts, a SQL-stream SHA-256 and verified gzip roundtrip checksum. A disposable database restore test preserved Unicode, quoting, BLOBs and indexes. This is a logical snapshot, not a native physical-file clone or a claimed full native restore test.

The approved handoff stopped only the packaged app/backend, took a stopped-profile APFS clone, confirmed its baseline messages, started the fixed backend under the real lock, and ran setup. It stopped at a newly exposed **archive/checkpoint namespace collision** before any model prompt: `V2 reboot recovery checkpoint is incomplete; retain evidence.` Both before/after history audits passed for **12,832 baseline messages**, none missing or changed. OpenCode remained PID 41478 with unchanged registration. The recovery backend exited and the packaged app reopened. This run's `result.json` is `passed: false`; no upgrade or model success is implied.

### Installation-only archive recognition

The original profile retains one correctly signed `bigbud.thread.locked-installation-identity.v1` archive in `recovery/`, created by the earlier metadata repair. The optional reboot reader previously treated **any existing recovery directory** without a checkpoint as an incomplete reboot, including this unrelated archive. A regression reproduced the exact error after successful identity maintenance and before restart/setup.

The reader now recognizes a nonempty namespace containing only exact installation-only archives as **no reboot checkpoint**, never reboot proof. It verifies outer and nested signatures, strict archive/publication shapes, the content-derived filename, unchanged committed plugin bytes and inodes, and a uniform device-only transition. Empty, partial, unknown, misplaced, orphaned-seal, changed-inode and invalid-signature evidence still refuses. No archive is deleted or rewritten. Shared signed-record verification was extracted from the existing reader, and the archive-key calculation is shared with its writer.

The added regression matrix and affected reboot/setup/recovery suites passed **10 files / 69 tests**; additional signed-inventory, cleanup-guard and dead-backend checks passed **3 files / 13 tests**. Server typecheck, explicit formatting/lint and the package build passed. Read-only execution of the corrected reader against the actual original archive returned no checkpoint/proof and preserved enrollment inventory. The source fix is not loaded by the reopened packaged backend.

The user separately approved another handoff. A fresh run directory `~/.bigbud/backups/opencode-recovery-20261108-014722/` pins the rebuilt backend and new app/backend PIDs, uses a fresh token/profile clone, and references the verified native snapshot above read-only rather than consuming another 4 GiB. No native mutation or model prompt was admitted by the failed preceding attempt. The previous run directories remain unchanged. Results for this second attempt must be read from its own `result.json`; preparation is not success.

### Original-owner settlement confirmed; launcher idle collision

The `014722` run completed native inspection/detach and signed settlement for **both** `f7904ca05199…` and `f92895db26e3…`, with `registry-absent` detach evidence, exact dead-backend receipt fences and `receiptsSettled: true`. A subsequent read-only audit invoked the production `V2EnrollmentRetirement.assertSettled` validator and passed for both owners. The enrollment-release failure is therefore repaired on the original profile, not merely in fixtures.

The run still returned `passed: false`: publication stayed `waiting-for-idle` until the verifier's bounded setup deadline. The managed launcher shell remained running while its pipe observer waited for the detached runner, so the native shell-activity gate correctly refused publication. Ending the coordinating turn did not end that managed shell. No idle check is being exempted or weakened; the corrected launcher instead returns immediately after detaching the runner, leaving no managed observer shell. A focused test confirms immediate launcher return and one-shot refusal.

This attempt again preserved all **12,832** baseline messages, left OpenCode PID 41478/registration unchanged, and reopened the packaged app after stopping the temporary backend. No v4 publication or model prompt succeeded in this attempt.

The external verifier also had an older proof-format assumption: it demanded six live-owner boolean fields from a valid versioned dead-backend proof. Its replacement invokes the production retirement validator, which checks signed records, recognized proof shapes and exact signed receipt fences. A read-only original-profile preview passed; duplicate audit output was refused without overwriting evidence. New runner checks passed **13 Python tests**, including compressed snapshot restore, snapshot/identity fencing and detached launch; the existing **5 Node verifier tests** had already passed. These runner changes do not change production retirement requirements.

With fresh explicit approval, a further fully detached attempt is prepared in `~/.bigbud/backups/opencode-recovery-20261108-015446/`. It uses a new token/profile clone and the retained verified native snapshot read-only. Unlike the earlier managed observer, it cannot automatically notify this conversation on completion; the user was asked to wait for app reopening and then request a result check. The reopened packaged app still contains its original bundled code, not a newly installed application build.

## Successful original-profile result

The user requested the result check after app reopening. The `015446` run's `result.json` is **`passed: true`**:

- Original profile lock and HTTP startup readiness verified for each temporary backend.
- Both original owner digests passed the production signed retirement/receipt-fence validator; `retirement-audit.json` records `settled` for each.
- `setup-latest.json` is `ready`, with committed bootstrap v4 digest `31e24f919ab7ca982f03dfc44a8e4c593ad05f34330d997dd45a8f6f0711e2ff` matching the desired artifact. Native version: 2.2.6. Runtime eligibility is verified; no universal native qualification is claimed.
- Real-model first reply, same-thread follow-up and same-thread reply after an actual recovery-backend restart all passed. The verifier selected `gpt-6.1-sol`; each `passed-*.json` contains its unique exact reply marker and the same test thread ID `bf6b2a34-0fcf-4a7a-aad6-0b89c278b8d3`.
- Three history audits passed. The baseline was **12,832** messages; the final count was **12,838**, with zero missing/changed baseline rows. The six additions are the three verification prompt/reply exchanges. The earlier 12,823-message baseline is contained in the preserved later baseline; nothing was deleted to pass recovery.
- OpenCode's registration remained unchanged at PID **41478**. Both temporary backends (33530 and 45747) exited before the packaged app reopened. A subsequent process check confirmed the reopened packaged app/backend at PIDs **52168/52596**, owning the normal profile lock; the detached coordinator process also exited.

Previous backups/run evidence remain retained. No commit, push, workspace-wide check, native service restart, fabricated proof or prompt replay occurred. The packaged application was not rebuilt/replaced, and no manual UI/composer verification on that reopened bundle is claimed. Packaging the source fixes is a separate deployment step; these results certify the bounded fixed-backend recovery against the original profile.

## Packaged build and user confirmation

After the successful original-profile run, a separate unsigned macOS arm64 app was built from the fixed source. Desktop, web, server and native-sidecar builds passed; all 437 packaged server JavaScript files matched the fresh server build, and packaged native-helper checks passed. Packaging did not replace or close the running app. The user subsequently confirmed the rebuilt app works and requested commit/push.

The earlier deployment caveats above describe their respective investigation stages. Original-profile recovery and the rebuilt app are now verified to the bounded extent recorded here; no Windows/Linux packaged validation or universal OpenCode compatibility is claimed. Backups, historical evidence and the working app bundle are retained.
