# Server-Owned Immediate Thread Deletion Plan

**Date:** 18 August, 2026
**Status:** Implemented through migrations 081-093; validation pending
**Owner:** bigbud team

## Summary

Replace the current multi-stage thread-retention and purge-job protocol with one server-owned immediate deletion operation. Every caller, including an explicit thread delete, project delete, scheduled retention, and one-off time-based cleanup, will use the same operation.

The server will stop the complete thread subtree's live resources, remove its managed files, and delete its database records in one request. Deleting a parent will permanently delete all descendants. The renderer will only request deletion and navigate; it will never ask to or attempt to delete a worktree itself.

This removes the retention queue, safe-checkpoint messaging, purge-job backlog gate, and separate renderer worktree mutation that currently make deletion difficult to understand and capable of stalling indefinitely.

### Current implementation boundary

The server-owned runtime and filesystem path, subtree fencing, direct retention selection, renderer cleanup removal, purge-backlog independence, canonical cleanup recovery, and bounded legacy-manifest recovery are implemented. SQLite cascade migrations 081-093 now cover messages, activities, sessions, tasks, proposed plans, pending approvals, pending user inputs, usage contributions, attachment references, turns, provider runtime state, checkpoint diff blobs, learning jobs, skill proposals, watch endpoints, delegation endpoints, runtime/liveness rows, automation rows, and thread identity. The self-referential thread cascade and cross-project automation ownership remain gated behind a separate write-order audit. The current release still uses the explicit `EntityPurge` transaction for relationships without a declared cascade, and restart/replay plus full-suite validation remain required.

## Related Work

- [Automatic thread cleanup](../thread-retention.md) documents the current retention behavior that this plan supersedes.
- [Local Project Thread Purge Recovery Record](2026-08-17-local-project-thread-purge-recovery.md) documents the prior direct administrative cleanup and its attachment validation.
- [Donna-kukama Thread Purge Recovery Runbook](2026-08-17-donna-kukama-thread-purge-recovery.runbook.md) records the dependency inventory that the new cascade migration must cover.
- None identified for a repository issue, pull request, bigbud note, or Kanban card.

## Problem

Thread deletion currently crosses a command/event lifecycle, runtime teardown, durable purge manifest, baseline proof, explicit per-table database cleanup, filesystem cleanup, verification, and retryable purge-job state. Automatic and manual retention add a second durable queue and priority system on top.

The active local state demonstrates the operational failure:

- Eight retention runs are `queued`; none holds the active slot.
- There are 495 incomplete purge jobs, 359 of which are failed.
- The retention worker refuses to claim a run when incomplete purge jobs reach 100, leaving every new manual request queued indefinitely.

The UI therefore reports that cleanup is ready for a safe checkpoint even though it cannot start. This behavior comes from the purge-backlog guard in `apps/server/src/retention/Layers/ThreadRetention.worker.ts:149-152`, not from a thread-specific condition.

The renderer also has a second owner for worktree cleanup. `useThreadActions.ts` asks whether to remove an orphaned worktree, waits for the server-side thread deletion to disappear, then executes a Git worktree mutation itself (`apps/web/src/hooks/useThreadActions.ts:128-220`). The server independently includes managed worktrees in `EntityPurge` (`apps/server/src/deletion/Layers/EntityPurge.ts:105-116`). This split ownership can race and produces confusing outcomes such as a deleted thread with a renderer-reported worktree failure.

## Goals

- Delete a requested thread subtree immediately after live runtime shutdown succeeds.
- Make the server the sole owner of managed attachment, screenshot, log, checkpoint, and managed-worktree cleanup.
- Delete all thread-owned database records with SQLite foreign-key cascades.
- Delete a parent and all descendant threads as one irreversible operation.
- Make manual time-based cleanup run immediately after confirmation, without queueing behind scheduled or historical work.
- Make automatic cleanup run once daily using the same deletion operation.
- Skip, report, and retry on the next daily run only subtrees that are pinned or active at selection time.
- Never delete a newer child merely because an older parent passes a time-based retention cutoff.
- Remove legacy purge-job backlog from the normal deletion path.
- Retain strict path-containment, symlink, shared-attachment, and managed-worktree safety checks.
- Keep deletion observable with concise user-facing completed/skipped/failed counts.

## Non-Goals

- Providing undo or restoring a deleted thread.
- Deleting arbitrary user files outside bigbud-managed roots.
- Deleting a provider's remote conversation unless that provider exposes an explicit, supported delete operation and it is separately designed.
- Retaining the current safe-checkpoint, page-budget, cross-run priority, baseline-gated purge, or durable purge-job workflow.
- Running SQLite `VACUUM` as part of normal deletion or cleanup.
- Preserving the current behavior that detaches child threads when their parent is deleted.

## Current State

### Explicit thread deletion

- The web app dispatches `thread.delete`, then separately offers and performs renderer-owned worktree deletion: `apps/web/src/hooks/useThreadActions.ts:128-220`.
- `thread.delete` emits `thread.deletion-requested`; `thread.delete.finalize` emits `thread.deleted`: `apps/server/src/orchestration/deciderThreads.lifecycle.ts:163-220`.
- The deletion reactor stops a provider session, closes browser, terminal, and shell resources, and aborts a manual deletion if a teardown step fails: `apps/server/src/orchestration/Layers/ProviderCommandReactorHandlers.delete.ts:119-262`.
- Manual deletion creates an `EntityPurge` job, finalizes the event, then invokes the purge job immediately. Retention marks an item prepared and waits for later batch processing instead: `apps/server/src/orchestration/Layers/ProviderCommandReactorHandlers.delete.ts:235-262`.

### Purge and retained data

- `EntityPurge` captures a resource manifest, waits for a verified baseline and deletion marker, explicitly deletes dependent rows, removes filesystem resources, verifies them, and finally removes the root projection: `apps/server/src/deletion/Layers/EntityPurge.ts:93-145,248-395`.
- The current explicit database dependency list is in `apps/server/src/deletion/Layers/EntityPurge.sql.ts:172-262`. It has to be maintained manually as new thread-owned tables are added.
- Most thread-owned tables do not declare foreign keys to `projection_threads`; SQLite foreign keys are enabled globally in `apps/server/src/persistence/Layers/Sqlite.ts:30-38`.
- Current deletion intentionally detaches children and nulls source-plan references rather than deleting descendants: `apps/server/src/deletion/Layers/EntityPurge.sql.ts:230-237`.
- Attachment references are maintained by triggers rather than foreign keys: `apps/server/src/persistence/Migrations/070_ThreadAttachmentReferences.ts:106-177`.
- The event store and global projection baseline can persist thread content outside projection tables: `apps/server/src/persistence/Migrations/001_OrchestrationEvents.ts:8-43` and `apps/server/src/persistence/Migrations/056_ProjectionBaselines.ts:8-86`.

### Retention

- Policies currently offer 1, 2, 3, 7, 14, 30, or 90 days and `never`: `packages/contracts/src/core/settings.threadRetention.ts:3-49`.
- The server starts retention after startup and the schedule begins after ten minutes, then repeats daily: `apps/server/src/retention/Layers/ThreadRetention.scheduler.ts:19-32` and `apps/server/src/startup/serverRuntimeStartup.ts:264-281`.
- The UI describes queued safe-checkpoint execution and displays a manual cleanup control: `apps/web/src/components/settings/ThreadRetentionSettingsSection.tsx:149-210`.
- Selection, retention-item state, purge preparation, and delayed purge are spread across `apps/server/src/retention/Layers/ThreadRetention.coordinator.ts`, `ThreadRetention.coordinator.dispatch.ts`, `ThreadRetention.coordinator.prepare.ts`, and `ThreadRetention.coordinator.purge.ts`.

## Phases

### Phase 1: Establish The Direct Deletion Contract

**Goal:** Define one server operation and one exact deletion policy before changing persistence.

1. Create a focused `ThreadDeletion` server service with an operation equivalent to `deleteNow(rootThreadId)`.
2. Resolve the full descendant set from `projection_threads.parent_thread_id` before starting destructive work. Treat the requested root and every descendant as one deletion unit.
3. Acquire a server-side deletion fence for the root before resolving descendants. Reject new child-thread creation, prompts, and runtime startup when a thread or any ancestor is fenced. Release the fence only when the operation fails; successful deletion removes the fence with the subtree.
4. Re-resolve the subtree immediately before database deletion and confirm no member was added or became active after preflight. A subtree is skipped when any member is pinned or has a live provider, browser, computer-use, terminal, shell, activity lease, or worktree lease.
5. Replace the single-thread finalization projection with a subtree-aware event/command result. The in-memory read model and every connected renderer must remove every deleted descendant, not only the root, before the cascade removes their persisted rows.
6. Move runtime teardown into the shared service. Retain the current provider/browser/terminal/shell shutdown behavior and bounded timeouts from `ProviderCommandReactorHandlers.delete.ts`; remove the retention-specific duplicate cleanup path in `ThreadRetention.cleanup.ts`.
7. Define a single outcome model: `deleted`, `skipped_active`, `skipped_pinned`, or `failed`. A failed teardown must leave the subtree undeleted. A skipped subtree is not a failure and becomes eligible during a later sweep.
8. Make project deletion enumerate its root thread subtrees and call the same service before removing project-owned records.

**Expected result:** Every deletion caller has one server-owned behavior, and no caller independently decides how to delete a worktree or attachment.

### Phase 2: Make Database Ownership Declarative (Deferred)

**Goal:** Replace the manually maintained thread-dependent delete list with SQLite cascades.

1. Audit every table in `EntityPurge.sql.ts:172-204`, every migration after `005_Projections.ts`, and every table with a `thread_id`, `parent_thread_id`, `caller_thread_id`, `child_thread_id`, `watcher_thread_id`, `watched_thread_id`, or `target_thread_id` column.
2. Before enabling foreign keys, add a migration preflight that detects and repairs or rejects invalid existing parent references, cycles, and orphan relationship rows. A self-referential cascade cannot be introduced safely over an invalid historic thread graph.
3. Add a SQLite migration that rebuilds thread-owned tables with foreign keys to `projection_threads(thread_id) ON DELETE CASCADE`. SQLite requires a table rebuild to change a foreign-key definition; do not attempt to bolt cascades onto existing tables.
4. Use cascade semantics for records exclusively owned by a thread, including messages, activities, attachment references, tasks, proposed plans, sessions, turns, approvals, pending inputs, usage contributions, checkpoint blobs, provider runtime state, activity/worktree leases, learning jobs, and thread-specific automation state.
5. Use endpoint cleanup semantics for relationships where either endpoint may be deleted, including watches and delegations. Delete the relationship row when either referenced thread is deleted.
6. Use recursive child deletion. Define `projection_threads.parent_thread_id` as a self-referential `ON DELETE CASCADE` relationship and remove the current child-detach update.
7. Use `ON DELETE SET NULL` only for a relation whose owner remains meaningful without the deleted source, such as an independently retained turn that only references a source proposed-plan thread. Document each exception in the migration.
8. Add foreign keys for attachment-reference source ownership, or replace the current trigger-only association with a foreign-key-safe design. Confirm that deleting a message or activity removes its attachment reference before the thread root cascade runs.
9. In one SQLite transaction, delete the selected root thread. The database must cascade every declared dependent row. Keep a post-transaction assertion in tests, not a production per-table deletion list.

**Expected result:** Adding a new thread-owned table requires declaring its ownership in schema rather than remembering to edit a central deletion SQL list.

**Release gate:** Do not enable this phase until all production and test write paths either create valid projection-thread parents or the ownership model is narrowed to tables whose rows are guaranteed to be thread-backed. The attempted migration was removed from the active migration loader because it caused widespread `FOREIGN KEY constraint failed` errors in otherwise valid isolated persistence tests.

### Phase 3: Make Server Filesystem Cleanup Immediate And Authoritative

**Goal:** Remove managed physical resources directly from the server without the purge-job protocol.

1. Before the database transaction, collect managed resources for the complete subtree: message attachments, computer-use screenshots, provider logs, terminal histories, checkpoint references, and managed worktrees.
2. Derive attachment paths only from persisted metadata before its source rows cascade away: parse `projection_thread_messages.attachments_json` and computer-use screenshot metadata in `projection_thread_activities.payload_json`, then resolve each valid attachment through `attachmentRelativePath`. Do not infer an attachment path from a thread ID or a filename.
3. Reuse the existing safe resource primitives in `EntityPurge.resources.ts` and checkpoint logic in `EntityPurge.checkpoints.ts`. Preserve managed-root containment, relative-path validation, no-symlink traversal, device/inode identity checking, and safe removal. Invalid or ambiguous attachment metadata must fail closed rather than target a guessed path.
4. Delete the root in the database transaction, allowing cascades to remove message/activity metadata and `projection_thread_attachment_refs`. After commit, use the pre-collected attachment IDs to query the retained reference rows. Remove a file only when no retained thread still owns that attachment ID.
5. Treat worktrees as server-managed resources only when their paths are beneath `config.worktreesDir` and exclusively belong to the deleted subtree. Never remove a user-selected path or a worktree owned by another retained thread.
6. Delete managed resources synchronously after the transaction. If filesystem cleanup fails, return a deletion result with the failed resource count, log the exact server-side error, and schedule only a narrow orphan-resource sweep. Do not reintroduce a thread-retention queue or make future thread deletions wait behind the failure.
7. Remove the renderer-owned worktree prompt, wait loop, Git removal mutation, error toast, and no-longer-used helpers/imports from `apps/web/src/hooks/useThreadActions.ts`. The renderer will dispatch deletion, navigate to its fallback, and render the server result only.

**Expected result:** A thread and its server-managed resources are deleted by one authority. A failed file cleanup is visible and recoverable, but cannot deadlock all later deletion.

### Phase 4: Remove Thread Content From Canonical Retention Storage

**Goal:** Ensure permanent deletion does not leave the conversation text or attachment metadata in the event store or a global baseline.

1. After the deletion command has updated the in-memory read model, remove the deleted subtree's thread aggregate events, command receipts, event IDs, stream state, identity records, and deletion markers in the same cleanup boundary as the projection deletion.
2. Before removing any event that is represented by a global projection baseline, create and verify a replacement baseline from the read model after the subtree is absent. Only then compact the covered event range and discard superseded baselines that retain the deleted thread content.
3. Do not delete global baselines blindly. They can include unrelated projects and threads. The implementation must prove that a replacement baseline excludes the deleted subtree before removing the older baseline/event data.
4. Add replay tests showing that a deleted thread cannot reappear after server restart and that retained threads/projects replay unchanged.

**Expected result:** "Permanently delete" removes the conversation and attachment metadata from both projections and canonical persisted history, without corrupting unrelated event streams.

### Phase 5: Replace Retention With A Daily Selector

**Goal:** Keep time-based cleanup while eliminating queues, safe checkpoints, and purge-job dependencies.

1. Keep the existing finite policy choices, confirmation challenge, preview, and `never` policy. Preserve rollout protection for installations with existing user threads.
2. Replace retention runs/items with a daily query for eligible root threads whose subtree's most recent `last_activity_at` is earlier than the selected cutoff. A newer inactive child protects its root from time-based cleanup.
3. Exclude only roots/subtrees that are pinned or active. Do not preserve a thread merely because it is watched, delegated, queued, has a historical task, or belongs to an older retention run; active work is already covered by the subtree preflight.
4. Invoke `ThreadDeletion.deleteNow` for each eligible root, sequentially with a bounded per-run batch size. Record one concise daily summary with deleted, skipped, and failed counts.
5. Make the manual control perform the same selection and direct deletion immediately after confirmation. Return the result to the UI; do not create a durable run, claim a slot, yield scheduled work, or poll an intermediate state.
6. Update `ThreadRetentionSettingsSection` to say that checks run daily and that manual deletion runs now. Remove the safe-checkpoint status copy, run polling, priority wording, and deferred state UI.
7. Update `docs/thread-retention.md` to describe the direct behavior, protections, no-undo semantics, and backup-only recovery.

**Expected result:** The manual button means delete now. Daily cleanup is predictable, bounded, and cannot be blocked by historical failed purge jobs.

### Phase 6: Retire Legacy Purge Infrastructure And Repair Existing State

**Goal:** Make the cutover safe for installations containing old purge jobs, including the current local state with 495 incomplete jobs.

1. Stop `ThreadRetention` and normal thread deletion from reading, creating, claiming, or blocking on `purge_jobs` before dropping any legacy tables.
2. Add a one-time migration that moves legacy incomplete jobs to the existing `manual_recovery_required` terminal state and records that they no longer control ordinary deletion. Do not silently delete their resource manifests.
3. Provide an administrator-only, bounded orphan-resource maintenance command that scans only bigbud-managed roots and removes resources proven unreferenced by retained database rows. It must report failures without blocking application deletion.
4. Ship the direct deletion path and legacy-job retirement in one release. Leave obsolete tables/migrations in place for one compatibility release, then remove their runtime services, metrics, tests, and UI assumptions once the maintenance command has been validated.
5. Remove `EntityPurge`, `PurgeJobRepository`, resource claims, baseline-gated purge coordination, retention item states, retention backlog metrics, and old retry scheduling only after the replacement path and migration have passed validation.

**Expected result:** Existing broken purge state cannot block new deletion, while historical orphan files have a bounded repair path.

## Risks And Decision Gates

- **Destructive data migration:** Foreign-key conversion rebuilds SQLite tables. Take and verify a complete state backup before migration tests and release. Validate with `PRAGMA foreign_key_check` and `PRAGMA integrity_check` after migration.
- **Parent semantics:** This plan intentionally changes parent deletion from detaching children to permanently deleting descendants. Confirm this wording in the delete confirmation before Phase 2 ships.
- **Subtree consistency:** A root-only deletion event plus a database cascade would leave descendant threads in the in-memory model until restart. The subtree-aware projection and deletion fence in Phase 1 are required before enabling recursive cascades.
- **Retention cutoff:** Time-based cleanup must use the newest activity in the whole subtree, not only the root's activity timestamp. Otherwise an old parent can unexpectedly delete a newer child.
- **Filesystem partial failure:** SQLite and filesystem deletes cannot be one atomic transaction. The selected contract is database deletion plus immediate server cleanup; a file cleanup failure creates an orphan-resource maintenance record, not a retained/deleting thread or a global queue blockage.
- **Canonical history:** Physical projection deletion alone is insufficient because raw event payloads and global baselines can contain conversation content. Phase 4 must be proven before describing deletion as permanent for persisted conversation data.
- **Provider data:** Local deletion cannot imply remote provider deletion. The UI and documentation must say that the provider's own retention policy may still apply unless a provider-specific remote-delete integration is added.
- **Runtime concurrency:** A thread or descendant becoming active after selection must cause the entire subtree to be skipped before any database transaction. The server, not the renderer, is authoritative.
- **Legacy data:** The existing 495 incomplete jobs must be retired from the normal path before manual cleanup is considered fixed. Do not attempt to make the new direct path process the old queue.

## Testing And Validation

- `bun fmt`, `bun lint`, and `bun typecheck` pass. Focused deletion tests found three legacy `EntityPurge` regressions; a compatibility fix was applied, but rerun is blocked by concurrent migration-loader edits referencing unavailable migration modules.

- Add schema migration tests that seed every thread-owned relation, invalid historic parent graph, and valid parent subtree; assert invalid graphs are handled deliberately and a valid parent deletion removes all descendants/dependent rows while retained projects and unrelated threads remain.
- Add foreign-key tests for direct child cascade, watch/delegation endpoint cleanup, attachment-reference cleanup, and every documented `SET NULL` exception.
- Add `ThreadDeletion` tests for provider/browser/terminal/shell teardown success, timeout, failure, descendant creation/startup rejection under a deletion fence, and a descendant becoming active during preflight.
- Add filesystem tests for attachment images/files, computer-use screenshots, pre-cascade metadata capture, shared attachments retained by another thread after the cascade, malformed attachment metadata, provider logs, terminal history, checkpoints, managed worktrees, path traversal, symlinks, inode swaps, and partial file cleanup failures.
- Add UI tests proving `useThreadActions` no longer opens a worktree confirmation or invokes a Git worktree mutation after delete.
- Add retention tests for daily direct selection, manual direct selection, pinned/active subtree skips, a newer inactive child protecting an older root, result counts, and absence of any purge-backlog or safe-checkpoint state.
- Add restart/replay tests covering canonical-event and baseline compaction after deletion.
- Add migration tests with legacy queued retention runs and incomplete/failed purge jobs. Confirm new manual deletion starts immediately and legacy state does not affect it.
- Run `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` before completion. Never run `bun test`.
- Manually verify a packaged and development desktop build: delete a single thread with attachments; delete a parent with descendants; delete a thread with a managed worktree; run manual time-based cleanup; wait for daily cleanup; restart after each path; inspect the retained UI and resource directories.

## Acceptance Criteria

- Deleting a thread from the sidebar makes the server, not the renderer, the only cleanup owner.
- The renderer contains no worktree confirmation, wait-for-disappearance loop, or Git worktree mutation after thread deletion.
- A parent deletion permanently removes all descendants and their thread-owned database rows and managed resources.
- Connected clients and the in-memory read model remove every descendant in the same deletion result; no descendant reappears after restart.
- The current release removes all declared dependent rows through the server-owned explicit transaction; SQLite foreign-key cascades remain a follow-up migration gated by fixture and historic-data compatibility.
- Manual time-based cleanup starts and completes in the invoking request; it never displays a queued or safe-checkpoint state.
- Daily cleanup uses the identical direct deletion operation.
- Pinned and active subtrees are skipped with an observable result and are eligible again on a later run.
- A newer child prevents time-based cleanup of its older root subtree.
- Existing failed/incomplete purge jobs do not delay or prevent a new deletion.
- Attachment files are removed only when no retained reference owns them.
- No deleted conversation content remains in projections, raw thread events, command receipts, stream state, or superseded global baselines.
- Formatting, lint, typecheck, focused deletion/persistence tests, and the full web suite pass. The full monorepo `bun run test` run exceeded the five-minute command window before completion and must be rerun in a longer-lived CI/local session before release.

## Open Questions

- Should a delete confirmation explicitly state the number of descendant threads that will be permanently deleted, or is a single "this thread and its child threads" warning sufficient?
- Should filesystem orphan cleanup be exposed in Settings, a support-only command, or only a server startup maintenance task?
- Should the user receive a non-blocking warning when local cleanup succeeded but a provider may retain its remote conversation under that provider's policy?
