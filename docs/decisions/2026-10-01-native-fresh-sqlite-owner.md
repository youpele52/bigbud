# Native Fresh SQLite Owner

**Status:** Implemented bounded foundation; independent review pending

**Date:** 1 October, 2026

## Context

The separate migration owns only its independent native-preview profile. Original
application/profile/worktree authority is unchanged; this explicitly requested
decision record is the only original-checkout write. Baseline: `7142d10c6a9d3ccfb13c9dcb844b3916f33d8e5c`.

## Decision

Use approved rusqlite 0.40.2 bundled/backup on one blocking connection owner with
finite typed admission, no arbitrary SQL/closures. First expose library integrity,
schema inspection and supported backup, not product commands.

Execute all 121 source migrations and startup repair on a fresh synthetic oracle.
Atomically materialize its final schema/initial rows into a fresh Rust DB. This
avoids mechanical translation of historical data rewrites for empty state; it
does NOT implement historical upgrade/import/resume. Existing DBs fail closed.
Preserve source migration IDs/names with current destination timestamps.

Keep WAL/FKs/5000ms busy timeout, private files and exclusive SQLite ownership.
Use supported SQLite page backups, never raw WAL copies. Accepted requests settle
despite caller loss. Shutdown stops admission, drains, then interrupts/reports
uncertainty if bounded waiting expires. Broken storage may outlive the wait; do
not invent forcible thread termination. Settings remain JSON-file-owned.

## Consequences

Real maintained storage without original-profile access. Historical upgrades and
product receipts/events need later plans/review. No performance claim.

The 2 GiB `/tmp` mount filled during isolated baseline installation. Only this
session's disposable reference was moved to the larger filesystem at
`/root/DevWorld/.migration-reference/bigbud-rust-baseline-7142d10`; synthetic runtime
profiles remain under `/tmp/opencode`. No unrelated content was removed.

## Validation

Linux Rust 1.95.0 fmt/clippy/66 tests/release and all source oracle checks pass.
Results: migration `docs/plans/2026-10-01-sqlite-foundation-validation.md`, port
decision 0007. Permits bound completed unread replies as well as active/queued
work. Exceptional Drop signals interruption but cannot force stalled storage
termination; explicit shutdown retains the owner on timeout for later settlement.
Independent review requires parent dispatch: nesting blocked. Original app and
all original profiles remain unchanged; native CLI storage integration is pending.
