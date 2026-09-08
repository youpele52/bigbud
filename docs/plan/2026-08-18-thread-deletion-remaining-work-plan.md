# Thread Deletion Remaining Work Plan

**Date:** 18 August, 2026
**Status:** In progress; direct deletion, canonical recovery, and cascades 081-092 are implemented; parent/self-referential and canonical ownership remain gated
**Owner:** bigbud team

## Current Baseline

Commit `a55fecfe4` moved the user-facing deletion flow toward one server-owned path:

- The renderer no longer removes managed worktrees.
- Parent deletion resolves and removes its descendant subtree from the in-memory model and connected clients.
- A deletion fence blocks new child creation, prompts, and provider startup while a subtree is being deleted.
- Manual and scheduled retention select eligible root subtrees directly. Historical incomplete `purge_jobs` no longer exclude candidates or block retention selection.
- A newer descendant's activity prevents an older root from qualifying for time-based deletion.

The direct deletion path, bounded canonical-history recovery, and incremental ownership migrations are implemented in the current worktree. Remaining release work is validation and operator documentation; new deletion does not require a queued purge worker.

The bounded ownership migrations through 089 are now present for projection rows, turns, runtime state, auxiliary thread records, watches, and delegations. `EntityPurge` no longer inventories those migrated rows for normal dependent deletion or orphan cleanup; non-owned operational and cross-project records remain explicit until their write contracts are redesigned.

## Scope And Order

### 1. Release Validation And Honest Product Language

**Goal:** Verify the committed path behaves correctly before further persistence changes.

1. Run `bun run test` in CI or another environment without the current local command limit. Focused deletion and migration tests pass; the local full run reached unrelated migration/fixture failures before termination.
2. Manually verify development and packaged desktop builds with:
   - a single thread with attachments and screenshots
   - a parent with child/delegated threads
   - a managed worktree
   - a pinned subtree and an active subtree
   - manual time-based cleanup and the next scheduled cleanup
3. Confirm the deletion confirmation says that child threads are permanently deleted with their parent.
4. `docs/thread-retention.md` and user-facing wording describe projection and managed-resource deletion. Keep any claim that all local canonical history is erased gated on restart/replay validation.

**Exit criteria:** The release path passes all tests and desktop checks, and product wording matches what is actually removed.

### 2. Remove Purge Jobs From Normal Deletion

**Goal:** Make normal user deletion and retention direct operations instead of creating a durable `purge_job` that happens to run immediately.

Normal thread and project deletion no longer calls `EntityPurge.requestThread()` or creates a new `purge_job`. `EntityPurge` remains for legacy recovery and for the explicit dependent-row transaction covering tables not yet migrated to cascades.

1. Continue extracting only the remaining reusable database-delete and verification primitives from `EntityPurge` as each ownership group is migrated; resource discovery and safe filesystem removal already live in the direct deletion path.
2. Implement one direct server operation with this exact sequence:
   - acquire the subtree fence
   - preflight the complete subtree for pinned/active state
   - stop provider, browser, terminal, and shell resources
   - capture managed resource metadata before dependent rows are removed
   - persist and project the subtree `thread.deleted` event
   - delete dependent database rows synchronously in one transaction
   - remove managed files synchronously using the captured metadata
   - return `deleted`, `skipped_active`, `skipped_pinned`, or `failed`
3. Keep `EntityPurge` and `PurgeJobRepository` only for legacy recovery until step 3 completes. Normal sidebar deletion, project deletion, manual retention, and scheduled retention must not call `requestThread`, `run`, `runBatch`, or `auditAndResume`.
4. Ensure a filesystem failure is returned/logged as an orphan-resource result without leaving a deleting thread, creating a general backlog, or blocking future deletion.
5. Add a migration that transitions existing incomplete purge jobs to `manual_recovery_required`. Preserve their manifests for recovery; do not process them as part of a new user deletion.

**Exit criteria:** A new deletion creates no `purge_jobs` row, no legacy purge worker is needed for new work, and the existing 495 incomplete jobs cannot influence the user-facing path.

### 3. Provide Bounded Legacy Orphan Recovery

**Goal:** Deal with physical remnants from historical failed purge jobs without restoring global deletion queues.

1. Use the administrator-only retired-manifest recovery command; it processes only captured, identity-verified resources from retired purge jobs rather than scanning arbitrary roots.
2. For each candidate, prove it is unreferenced by retained database rows before removal.
3. Reuse managed-root containment, no-symlink traversal, inode/device identity, and shared attachment checks.
4. Report deleted, retained, malformed, and failed resource counts. Never make this command a prerequisite for deleting a new thread.
5. Document backup and dry-run requirements in the existing purge recovery runbook.

**Exit criteria:** Historical resources have a bounded repair path, while normal deletion remains independent of repair outcomes.

### 4. Remove Deleted Content From Canonical History

**Goal:** Make "permanent delete" accurate for locally stored conversation and attachment metadata.

Projection deletion alone is insufficient because `orchestration_events`, command receipts, stream state, identities, deletion markers, and global baselines can retain content.

1. Define a canonical compaction boundary for one deleted subtree.
2. Build and verify a replacement baseline after the subtree is absent, while retaining unrelated projects and threads.
3. Delete the subtree's aggregate events, event IDs, command receipts, stream state, identity records, and obsolete deletion markers only after the replacement baseline proves replay safety.
4. Add restart/replay tests showing deleted threads never reappear and retained data is unchanged.
5. Keep provider-remote retention explicitly out of scope unless a provider exposes a supported remote delete API.

**Exit criteria:** A post-restart replay cannot recover deleted local conversation content from canonical storage or a retained baseline.

### 5. Introduce SQLite Cascades Incrementally

**Goal:** Replace the explicit dependent-row inventory with declarative ownership only after the data model supports it.

The first broad migration attempt was correctly removed because mandatory foreign keys broke valid isolated repository workflows that create rows using thread IDs without projection-thread rows. Do not repeat a single all-table rebuild.

1. Produce an ownership matrix for every table referenced by `EntityPurge.sql.ts` and every column named `thread_id`, `parent_thread_id`, `caller_thread_id`, `child_thread_id`, `watcher_thread_id`, `watched_thread_id`, or `target_thread_id`.
2. Classify each relation as one of:
   - exclusive thread ownership: eligible for `ON DELETE CASCADE`
   - independent record with an optional source: eligible for `ON DELETE SET NULL`
   - relationship row: delete when either endpoint is deleted
   - operational/cross-cutting record: no thread foreign key until its write contract is redesigned
3. For each proposed foreign key, first make production writes and isolated test fixtures create a valid parent row. Add a migration preflight to repair or reject historic orphans and parent cycles.
4. Migrations 081–092 now add small-group cascades for projection messages, activities, sessions,
   tasks, state rows, attachment references, turns, runtime/auxiliary rows, watches, and
   delegations, runtime leases, provider-turn liveness, and automation schedules/runs. Each group
   repairs historic orphans and has focused migration/integrity coverage; full server/restart
   validation remains a release gate.
5. Keep nullable cross-thread provenance fields out of the FK unless their `SET NULL` contract is
   separately verified. The self-referential parent relation and canonical identity/event tables
   remain explicit pending subtree replay and parent-write audits.
6. Delete entries from the explicit direct-delete SQL inventory only when the matching cascade has
   passed its migration, parent-write, and restart tests. The migrated 081–092 groups no longer
   use explicit dependent-row deletes; project-owned automation rows and the remaining
   self-referential/canonical relations remain explicit.

**Exit criteria:** Every declared cascade has a valid parent-write contract, verified migration behavior, and a test proving deletion removes precisely the owned rows.

### 6. Retire Obsolete Retention Infrastructure

**Goal:** Remove code that describes or operates the old queued safe-checkpoint workflow.

1. Remove the unused retention coordinator, worker, item states, run slot, backlog metrics, purge preparation, and retry scheduling after steps 2 and 3 ship.
2. Remove stale `getRun` and `listRuns` RPC/UI polling if no user-facing direct result needs them.
3. Keep the finite policy choices, preview, confirmation challenge, `never` policy, daily startup delay, and one concise result summary.
4. Split oversized tests created or expanded by the cleanup where practical, keeping new/edited test files at or below 400 lines.

**Exit criteria:** The only retention execution path is daily/manual selection followed by direct deletion; no UI or server code can queue a safe-checkpoint cleanup request.

## Required Validation Per Phase

Current verification: formatting, lint, and typecheck pass. Focused deletion tests require rerun after the concurrently edited migration loader is stabilized; full-suite and manual desktop validation remain outstanding.

- `bun fmt`
- `bun lint`
- `bun typecheck`
- Focused Vitest tests for changed server and web modules
- `bun run test` in a non-time-limited CI or local session
- For destructive migration phases: backup/restore rehearsal plus `PRAGMA foreign_key_check` and `PRAGMA integrity_check`

## Dependencies

1. Complete step 1 before release promotion of the committed direct path.
2. Complete steps 2 and 3 before removing purge-job services or tables.
3. Complete step 4 before describing local deletion as permanent across all persisted state.
4. Complete step 5 only after the direct path is stable; it is a maintainability improvement, not a prerequisite for immediate user deletion.
5. Complete step 6 last.
