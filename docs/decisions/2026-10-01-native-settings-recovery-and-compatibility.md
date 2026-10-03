# Native Settings Recovery And Compatibility Readiness

**Date:** 1 October, 2026

**Status:** Implemented; parent static bounded Linux approval

## Context

Parent independent static review approved the bounded Linux fresh-only runtime
continuation and closed the effective compiler-flag P2. It did not rerun checks.
Historical compatibility and full settings semantics remain required before
existing-profile startup/import or mutating RPC authority can be enabled.

## Decision

Implement source-backed settings normalization, field-wise recovery and lenient
JSON parsing with the pinned source's exact three-pass comment/trailing-comma
behavior, including its quirks. Persist settings as sparse JSON, never SQLite.
A bounded synchronous owner serializes cache, authorized retention policy and
atomic file replacement; call it only on a blocking owner, not an async thread.
Separate settings normalization and runtime provider fallback; retain historical
unknown-provider selections losslessly during tolerant recovery/unrelated updates.
Settings-only patch APIs refuse retention policy changes; explicit policy setter
is internal until the durable retention authorization owner is implemented.
External reload always reconciles the in-memory authorized policy and quarantines
unauthorized disk edits. File publication uncertainty poisons the owner until
explicit recovery rather than blindly retrying an ambiguous write.

Use private same-directory staging, file sync, rename for intentional replacement
and directory sync. This differs from fresh/no-overwrite seed and backup: updating
the already owned settings file intentionally replaces it. Preserve trusted-parent
and Unix durability limits. Add deterministic publication-boundary failure tests.
No watcher/update RPC or existing-profile CLI is enabled by this slice.

Historical readiness is a read-only migration-journal classifier backed by actual
source prefix/upgrade executions. It reports required migrations, unknown/future
versions and inconsistent journals; never equate final migration row with schema
fidelity or historical data compatibility. No historical SQL replay or resume
claim is made. Fresh-only refusal remains until representative upgrade/recovery
and independent review gates are complete.

## Consequences

Parent independent static review approved this bounded Linux continuation with
no confirmed blockers/no undocumented reliability weakening. It did not rerun
the81 tests/16oracles. New dispatch/upgrade-proof work is separately documented in
[next decision](2026-10-01-native-settings-dispatch-and-upgrade-proofs.md).

No new dependencies/features. Tests use synthetic owned profiles and source
databases only. Existing app/live data remain unchanged. Platform ACL/reparse,
Windows env channels and directory durability remain unresolved; no certification.
Independent review is required for new settings authority/persistence before
wiring product mutation RPCs or enabling resume/import.
