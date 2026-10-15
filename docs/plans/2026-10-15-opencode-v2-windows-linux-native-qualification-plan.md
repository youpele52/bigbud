# OpenCode V2 Windows and Linux native qualification (deferred follow-up)

**Date:** 15 October, 2026
**Status:** Deferred
**Owner:** OpenCode V2 provider maintainers

This is the named follow-up required by the [gap-closure plan](./2026-10-15-opencode-v2-gap-closure-plan.md) Phase 4.6. The first release scope is macOS ARM64 shared-service mode (assumption A1 there). Native execution on Windows (D1) and Linux (D2) is out of scope until the triggers below are met. The table is copied verbatim from the gap-closure plan, so the owners and triggers stay authoritative there.

## Context

- Scope decision: [gap-closure plan](./2026-10-15-opencode-v2-gap-closure-plan.md), Definition of Done item 7, plus its "Amendment 2026-10-15 (implementation findings)".
- Narrowed release scope (D8): the "Amendment 2026-10-15 (gap closure)" in the [2026-09-29 implementation plan](./2026-09-29-opencode-v2-provider-implementation-plan.md).
- macOS ARM64 qualification path that a Windows or Linux job would mirror: the [2.0.29 preparation ledger](../validation/opencode-v2-native-qualification-2.0.29-2026-10-15.md) (two-pass approval provisioning, suite v2, egress evidence).
- Existing Windows evidence: the [cross-platform recovery ledger](../validation/opencode-v2-cross-platform-recovery-2026-10-14.md). Windows publication (`DuplicateHandle`, `GetMappedFileNameW`) has never executed natively.
- Schema constraint: `V2NativeIsolationApproval` (in `SharedService.native.isolation.fixture.ts`) accepts only `platform: "darwin"` and `arch: "arm64"`. D1 and D2 require widening it under a new reviewed suite revision.

## Deferred work (owner / trigger)

| ID  | Item                                                                                                                               | Owner                                   | Trigger to reopen                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Windows native execution and publication (socket `DuplicateHandle`, `GetMappedFileNameW` metadata, real reboot/hibernation, ARM64) | Follow-up plan 4.6                      | A Windows x64/ARM64 run of `.github/workflows/opencode-v2-shared.yml` with a 2.0.29 fixture and an approval record for `win32` (requires widening `V2NativeIsolationApproval.platform`) |
| D2  | Linux native installation/execution                                                                                                | Follow-up plan 4.6                      | `ubuntu-24.04` job with a `linux/x64` approval record                                                                                                                                   |
| D3  | Big Pickle free-tier HTTP 403 vendor predicate                                                                                     | Provider maintainers                    | Upstream documents free-tier limits, or a second user report; fix is a `Catalog.native.ts` availability predicate marking such models `requires-setup`                                  |
| D4  | 10 MiB native media HTTP 500 (upstream) and non-atomic recursive delete                                                            | Upstream OpenCode                       | Upstream release notes a fix; keep the stress probe excluded until then                                                                                                                 |
| D5  | Explicit owned native-history deletion gate (10-09 design)                                                                         | Product decision + provider maintainers | User confirms D7 "explicit deletion removes owned native history when safe" and upstream exposes a conditional delete                                                                   |
| D6  | Reboot-recovery receipt outcome "unknown" after `st_dev` change                                                                    | Provider maintainers                    | Next user-initiated reboot with Phase 2.2 diagnostics in the build; resolve via `RebootRecovery.*` evidence, never by deleting the receipt                                              |
| D7  | `~/Documents` Location EPERM (macOS TCC, HTTP 500 empty body)                                                                      | Desktop maintainers                     | Decide between requesting Full Disk Access in the desktop shell and documenting the limitation                                                                                          |
| D8  | Promotion of future OpenCode releases (version drift policy)                                                                       | Provider maintainers                    | Each new stable release the user installs: rerun Phase 1 (workflow dispatch with the new version, new approval record, new evidence packet); never relabel an old record                |
