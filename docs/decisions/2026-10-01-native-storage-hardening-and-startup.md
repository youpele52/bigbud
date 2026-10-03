# Native Storage Hardening And Fresh Startup

**Status:** Implemented; parent independent static approval for bounded Linux fresh-only scope

**Date:** 1 October, 2026

## Context

Parent-dispatched static review approved corrected transport within its bounded
scope and found one SQLite P2: generic compiler flags bypassed the fixed-engine
environment policy. Review did not build alternate artifacts or rerun checks.
Other storage ownership/schema/feature boundaries were judged sound; backup
publication and deterministic blocked-worker/fault tests were follow-ups.

## Decision

Check all cc1.5.1 CFLAGS channels (global, HOST/TARGET, raw and normalized target)
and compiler selection with embedded argv. Register matching Cargo rerun inputs.
Only general optimization/debug/PIC/frame-pointer/warning flags in the explicit
allowlist are permitted; macros, undefines, forced includes, response files,
quoted flag strings and compiler embedded argv fail closed. Compiler executables
remain trusted build tools, not protection against a malicious compiler/wrapper.
Compiler executable paths containing spaces need later platform review.

Back up into exclusively reserved `snapshot.sqlite.pending`, verify and sync the
file, publish via atomic no-overwrite hard link, and sync its parent directory.
Remove only this call's owned failed stage; never repair an existing stage or
overwrite a published snapshot. Directory-sync errors after publication report
explicit publication uncertainty. Interrupted pending state is not importable.
Currently fail closed outside Unix until native directory durability is reviewed.
No ancestor-race/Windows security claim is added.

Add an explicit `--serve-db` fresh-only startup alongside unchanged `--serve`.
It owns SQLite and seeds sparse settings JSON before listening, waits for worker
readiness, and joins storage after transport shutdown. It still supports only
read-only ping/default settings/welcome; no commands/providers/readiness invented.
Settings use baseline JSON ownership, not a SQLite settings table. Port the
source sparse-default stripping policy against executed synthetic fixtures;
seed a private fresh settings file atomically. External edits, schema recovery,
watchers, update RPCs, existing profiles and historical upgrades stay gated.

## Consequences

This is executable runtime integration, not full persisted-settings/server parity.
No additional dependencies/features are authorized or added. Historical data
upgrades/import require source fixtures and reviewed implementations before
resume is enabled. Original application and live profiles remain untouched.

## Validation

Latest parent-supplied independent verdict approved bounded Linux fresh-only
continuation and closed the CFLAGS P2 with no new confirmed blockers. Static
review only; not a check rerun. Windows/trusted-parent/compiler-tool limitations
remain unresolved. Next recovery/authority/readiness work is documented in
[settings compatibility decision](2026-10-01-native-settings-recovery-and-compatibility.md).

Results are recorded in separate migration port decision 0008 and its continuation
validation. Static prior approval is never relabeled as correction approval or
independent execution. Parent re-review is required after this continuation.
