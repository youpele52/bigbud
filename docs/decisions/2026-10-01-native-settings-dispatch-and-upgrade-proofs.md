# Native Settings Dispatch And Representative Upgrade Proofs

**Date:** 1 October, 2026

**Status:** Accepted for bounded implementation; new-code review pending

## Context

Parent independent static review approved the settings/readiness continuation,
without rerunning its 81 tests/16 oracles. No confirmed blocker or undocumented
reliability weakening. Next prerequisites are representative historical data and
bounded settings dispatch/watch/retention authority, not premature resume/RPCs.

## Decision

Add injectable filesystem operation boundaries inside actual settings replacement
so write/rename/final-directory-sync faults test production mapping and retained
state, not a synthetic error after an already completed write.

Source-execute a representative prefix120 database containing accepted retention
policy/run/items and legacy message/attachment references, record source migration
121/122 statements, then prove transactional Rust replay against identical
synthetic schema/data. Keep replay compiled into tests only until broader
historical migration/recovery/security review is complete. CLI remains fresh-only.
The source oracle is a specification, never a packaged TypeScript dependency.

Add a dedicated bounded blocking settings worker for fresh seed/read/reload and
background invalidation. With no newly approved OS watcher dependency, use a
bounded content-signature polling adapter with a 100ms settle window. Latest-value
notifications carry monotonic versions; missed versions require full snapshot
rescan and are not an event-log substitute. This differs from source unbounded
PubSub/native watcher and does not yet satisfy public watch-RPC stream parity.
Keep mutations and trusted retention setters out of this dispatcher until durable
authorization and consent consumption are implemented/reviewed. Stop admission,
drain accepted reads, explicitly join; timeout retains supervision for retry.
Polling/reload failure reports a stale snapshot, never silently authoritative
settings or a deletion permission. Retention remains authorized Never in fresh
runtime; external JSON cannot authorize cleanup.

## Consequences

No new dependencies/features. No new writable filesystem paths or existing-
profile constructors. Input/state/queue/subscriber state bounded; blocking IO
off async reactor. Trusted-parent races/compiler tools/Windows protection remain
unresolved, not certified. Full history/import/resume and mutations stay gated.
Further JSON numeric/Unicode/deep edge parity must precede wider settings claims.
