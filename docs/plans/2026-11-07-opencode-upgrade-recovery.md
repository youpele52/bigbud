# OpenCode upgrade recovery implementation

## Goal

Resolve the v3-to-v4 managed-plugin upgrade blocked by retained dead-backend owners and unchanged installation device renumbering. Preserve native history, uncertain receipts, foreign registrations, current consent and physical-settlement guarantees.

## Work items

1. Add activation preparation that reuses existing dead-backend recovery for all matching registration owners, before replacement readiness; keep idle observation read-only. Inject the real state-directory-lock owner through the activation service. Preserve active native sessions and live/foreign backends. Honor cancellation without abandoning issued cleanup.
2. Support exact installed-object identity maintenance without assuming a historical reboot checkpoint. Require current expanded setup consent, verified native configuration scope, the exact backend lock and same-host ownership provenance, unchanged canonical inodes and signed bytes, closed local admission, and the publisher lock. Archive the original signed installation before conditional metadata replacement; never manufacture reboot, retirement, or completed-receipt evidence. Retain the historical checkpoint path where available.
3. Report safe compatibility mismatch field names and distinguish retained-owner recovery failures from filesystem maintenance. Allow a bounded watcher-settlement window for an older loaded contract after publication; never tolerate a mismatch as readiness.
4. Add focused regression coverage for multi-location v3-to-v4 recovery, pending/partial retirement, live/foreign owners, missing authority, identity transition and tampering, cancellation, publication and watcher settlement. Run focused formatter, linter, explicit file-length checks, server package typecheck and affected tests. Repeat lifecycle tests after corrections.
5. Resolve an older stable OpenCode release approximately ten releases behind and latest, download verified binaries to a disposable area, and exercise local bigbud dev with a separate native service/profile across older-to-latest transitions. Use bigbud computer use for UI testing. Preserve production native data and record actual tested versions and any live-model/auth limitations. Restore/stop only task-owned processes and remove temporary tooling when finished.
6. Run the requested review agent after implementation and testing, fix findings, run a second review, and fix remaining findings with focused revalidation.
7. Accept the documented OpenCode 2.2.6 `websearch.use` policy action while rejecting unknown actions, preserve the exact pre-change v4 signed descriptor, and rerun the native consumed-contract check. This additional blocker was reproduced through the real dev server.
8. Treat source-backed, known locationless native session notifications as read-only reconciliation hints, preserve admission and arrival fences, and retain official SDK/SSE tests alongside new rejection cases. Live 2.2.6 capture confirmed permissions, usage and completion notifications with no Location.
9. Update the investigation/validation evidence and stale provider setup documentation after verification. No commit or push without fresh approval; no broad checks without separate approval.

## Acceptance

- A fresh thread can upgrade a retained v3 installation after eligible dead owners across locations have safely retired.
- Live work and unknown/foreign ownership remain protected, with actionable reasons.
- Unchanged installation metadata can recover without fabricated historical reboot proof; replaced bytes/inodes and absent authority are rejected.
- No implicit prompt replay, native-history deletion, global reload or unrelated plugin replacement.
- Focused checks and repeated test results, native version-transition evidence, desktop interaction, and both review rounds are recorded honestly.

## Progress

The entries below record the implementation chronologically. The final outcome supersedes earlier pending UI and recovery statuses.

- Investigation complete; baseline four focused files / 41 tests passed.
- Recovery, metadata archive, safe mismatch diagnostics and watcher settlement implemented.
- First review identified preparation cleanup ownership and two test gaps; all corrected, with cancellation/consent/deadline and valid inode regressions passing.
- Focused baseline plus new coverage: 57 passed; correction run: 18 passed; activation/security run: 43 passed. These overlapping runs are not a unique-test total.
- Real native smoke turns passed on 2.1.1 and 2.2.6 using a local synthetic model. Full dev-server testing found the separate 2.2.6 policy-action blocker; correction and retest underway.
- Desktop interaction paused by the computer-use tool time limit, pending the requested user renewal.
- Second formal review and follow-up event review completed; no blocking code defect identified. Fixed final mismatch diagnostic preservation and restored the existing official SDK/SSE regression alongside the new hint matrix.
- Full dev-server turns passed twice on 2.1.1, once after same-profile upgrade to 2.2.6, and twice more after the event fix. The last two returned sessions to ready with no lastError and no ambiguous-stream diagnostics.
- Combined validation: 16 files / 150 tests; watcher correction: 1 file / 12 tests; final event/SDK/admission set: 6 files / 29 tests. Runs overlap.
- Final server typecheck, 26-file source checks and 13 document-link checks passed. All task-owned running processes were stopped; disposable test profiles/binaries remain available for UI continuation.
- Desktop UI validation is the remaining externally blocked item; computer use requires renewed user confirmation. No full-suite checks, commits or pushes were run.

## Final outcome

Original-profile recovery passed: both blocking owners passed production retirement validation, bootstrap v4 was installed, and real-model first, follow-up and backend-restart replies succeeded. All 12,832 baseline messages were unchanged; six verification messages were added. Manual dev UI checks passed before and after the native upgrade and with a real model across restart.

The packaged macOS arm64 app was rebuilt separately; all 437 packaged server JavaScript files matched the fresh build and native-helper checks passed. The user subsequently confirmed the rebuilt app works. Backups and run evidence remain preserved. See the [enrollment-release report](../reports/opencode-enrollment-release-2026-11-08.md) for the original-profile evidence and bounded validation scope.
