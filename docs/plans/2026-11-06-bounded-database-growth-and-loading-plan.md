# Bounded Database Growth And On-Demand Loading

**Date:** 6 November, 2026
**Status:** Proposed
**Owner:** bigbud server/web

## Summary

The packaged database has reached 8.7 GB, yet the threads, messages and activities it serves add up to about 150 MB. The rest is history that bigbud was designed to discard but no longer does:

- **Event-log compaction stopped running on 19 August, 2026.** A refactor unwired its only automatic caller, so the log has only grown since then.
- **Thread retention runs but deletes nothing.** The policy is set to 3 days, and 212 unpinned threads are older than that. Every run still reports 0 eligible, because 200 of them carry a provider runtime row stuck at `running`.
- **The command ledgers are never pruned.** These are receipts, claims, event IDs and gap rows, about 3.4 GB with their indexes.
- **Freed space never returns to disk,** because `auto_vacuum` is off.

On the loading side, most paths are already bounded, but three are not:

- **Scrolling up never loads older messages.**
- **Opening a thread loads 50 messages,** not the 10–15 asked for.
- **One web action and two mobile handlers still pull the full database snapshot.**

This plan does five things:

1. Make every read load only what is on screen, whatever the database size.
2. Unblock thread retention, so it does what Settings › Threads already says.
3. Restore automatic, load-safe compaction and add ledger pruning.
4. Reclaim the disk space.
5. Clean up orphaned attachments.

Each phase can ship on its own. User-facing retention choices come from the existing Settings › Threads controls; this plan adds no new retention settings.

## Related Work

- Bigbud note / Kanban card: none identified. The work came from a direct conversation on 6 November, 2026, following the out-of-memory investigation.
- `docs/plans/2026-11-05-connection-resilience-under-load-plan.md`: phase 5 ("database growth, decision gate") is superseded by this plan.
- `docs/plans/2026-08-18-deferred-canonical-cleanup-recovery-plan.md`: chose operator-only recovery with no background retry. Phase 3 of this plan reverses that decision; see Risks.
- `docs/plans/2026-08-18-server-owned-immediate-thread-deletion-plan.md`, phase 4: baseline-gated compaction after deletion. This plan reuses that mechanism.
- Commit `bc6f06c9bf` (19 August, 2026, "Migrated thread retention into unified deletion pipeline") removed `EntityPurgeLive` from `apps/server/src/server.ts`.
- Commit `3db98baec6` (26 August, 2026) coalesced assistant deltas into chunks of about 256 characters.

## Problem

### Measured on the packaged database (read-only, 6 November, 2026)

The file is `~/.bigbud/userdata/state.sqlite`: 8.77 GB, plus a 175 MB WAL. It has 4 KB pages, 73,924 free pages (about 300 MB), `auto_vacuum = 0` and WAL journaling.

| Table or index group                                         | Size           | Rows      | Notes                                                              |
| ------------------------------------------------------------ | -------------- | --------- | ------------------------------------------------------------------ |
| `orchestration_events`                                       | 3,148 MB       | 4,097,862 | Oldest event 24 April; max sequence 5,263,253                      |
| Event indexes (correlation, command, stream x2, autoindexes) | about 2,000 MB | —         | `idx_orch_events_correlation_id` alone is 540 MB and has no reader |
| `orchestration_command_receipts` and indexes                 | about 1,640 MB | 3,965,104 | Never pruned; oldest 21 April                                      |
| `orchestration_command_receipt_claims` and autoindex         | about 490 MB   | 1,510,933 | Never pruned                                                       |
| `orchestration_event_ids` and autoindex                      | about 420 MB   | 4,110,416 | Never pruned                                                       |
| `orchestration_event_gaps` and autoindex                     | about 140 MB   | 1,152,891 | Pruned only when compaction completes                              |
| `projection_baselines`                                       | 158 MB         | —         | Legacy single-row baseline; migration 152 converts it              |
| `projection_thread_activities` and indexes                   | about 190 MB   | —         | —                                                                  |
| `projection_thread_messages`                                 | 15 MB          | —         | The actual conversation text                                       |

Events split by the state of their thread:

| Thread state                              | Events    | Payload    |
| ----------------------------------------- | --------- | ---------- |
| No projection row (thread already purged) | 3,262,417 | 1,110 MB   |
| Soft-deleted (`deleted_at` set)           | 315,717   | 104 MB     |
| Live                                      | 518,142   | 286 MB     |
| Archived                                  | 1,635     | under 1 MB |

By type, `thread.message-sent` accounts for 2,832,966 events (891 MB of payload) and `thread.activity-appended` for 1,031,214 (474 MB).

`orchestration_retention_state` shows `retained_through_sequence = 12,500` against `compact_through_sequence = 5,235,819`. Nearly the whole log is covered by a verified baseline and allowed to be deleted, but nothing deletes it.

Thread retention:

| Fact                                                                    | Value                                                                                                       |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Policy                                                                  | `3-days`, explicit, `legacy-subtree`, `last-conversation-activity`                                          |
| Runs                                                                    | 145 (113 completed, 31 cancelled, 1 completed with failures); every recent run reports `eligible_count = 0` |
| Live threads / soft-deleted rows                                        | 264 / 248                                                                                                   |
| Unpinned threads older than the cutoff (by the selector's own age rule) | 212                                                                                                         |
| …with `provider_session_runtime.status = 'running'`                     | 200 (252 such rows exist in total; only 2 thread sessions are actually running)                             |
| …with a `worktree_runtime_leases` row                                   | 177 (all 225 leases are `provider` leases with a NULL `process_id`)                                         |
| …with a `pending`/`inProgress` task                                     | 25                                                                                                          |
| …on a non-local execution target                                        | 26                                                                                                          |
| …with none of these blockers                                            | 11 (likely blocked by subtree propagation in legacy mode)                                                   |

Attachments: 380 files, 136 MB, 142 of them older than 30 days. They are not what drives the size.

### Root causes (verified in code)

1. **Compaction has no production caller.** The prefix delete is `compactVerifiedPrefix` (`apps/server/src/persistence/Layers/OrchestrationEventStore.compaction.ts:7-83`). Its only callers are the manual CLI (`apps/server/src/cli/cli.ts:266`) and `EntityPurge.batch.ts:147,164`, and `EntityPurgeLive` is wired only in tests. The live deletion paths use the verify-only coordinator `ensureVerifiedBaselineThroughWithoutCompaction` (`CanonicalThreadCleanup.ts:83,102`, `DirectResourceCleanupRecovery.ts:89`).
2. **Runtime rows stay `running` after a turn ends.** `ProviderService.sendTurn.record.ts:74-86` writes `status: "running"` on every turn. Only a clean `stopAll` (`ProviderService.operations.ts:317-333`) or an explicit stop resets it, and no startup reconcile exists. Provider leases are removed only when the runtime is _not_ running (`ProviderSessionRuntime.ts:112-118`), so the leases leak with it.
3. **Retention treats those rows as running work.** The `running` exclusion (`ThreadRetentionRepository.eligibility.ts:50-62`) fires on any `provider_session_runtime` row in `starting`/`running`, or on any lease row. A bound but idle session looks the same as an active turn, and the delete handler would stop that session anyway (`ProviderCommandReactorHandlers.delete.ts:106-159`).
4. **The stored policy still uses the legacy subtree selector.** Migration 121 gave existing policies `legacy-subtree` (`Migrations/121_ThreadRetentionSelectionMode.ts:12-17`). The Settings preview runs `per-thread` (`ThreadRetention.preview.ts:44-47`). That is correct for both of its triggers, because a confirmed policy change switches to `per-thread` (`ThreadRetention.policy.ts:52-55`) and "Delete now" is per-thread, but nothing shows what the scheduled legacy-subtree run actually skipped.
5. **Deferred cleanup is never retried automatically.** Deferred canonical cleanup retries only for deletions with a direct-cleanup proof (`DirectResourceCleanupRepository.recovery.ts:85-99`). Soft-deleted rows had their only purge path in `EntityPurge.sql.ts:37-61`, which is unwired. Both leave orphaned history behind.
6. **The ledgers have no retention.** Receipts and claims are written for every command, including every streamed chunk (`OrchestrationEngine.commandProcessing.ts:96`). They are removed only by per-entity deletion. `orchestration_event_ids` has no index on `sequence`, so per-entity deletes scan it in full (`EntityPurge.sql.ts:307`).
7. **No space reclamation.** Only `journal_mode`, `foreign_keys` and `busy_timeout` are set (`apps/server/src/persistence/Layers/Sqlite.ts:58-60`). Nothing runs `VACUUM`, `incremental_vacuum` or `wal_checkpoint(TRUNCATE)`.

### Loading paths

Startup is already bounded (`apps/web/src/routes/-__root.bounded-bootstrap.ts:43-176`), and so are reconnect replay (4,000 events, then a reset), sidebar pages and search. The gaps:

| Path                                  | Status                                                                                                                                       | Evidence                                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Older messages on scroll-up           | **Missing.** `loadOlderThreadMessages` is called only by the question-history hook                                                           | `-__root.bounded-bootstrap.ts:178-219`, `MessagesTimeline.questionHistory.hook.ts:39`                                  |
| First message window                  | 50 by default, max 200                                                                                                                       | `packages/contracts/src/orchestration/orchestration.detail.ts:26`                                                      |
| `getSnapshot` from the web app        | **Unbounded.** Editing a remote workspace pulls the whole database to find one project's worktree paths                                      | `apps/web/src/components/sidebar/Sidebar.remoteWorkspaceAddActions.edit.ts:33`, `ProjectionSnapshotQuerySql.ts:52-245` |
| Mobile `getMobileThread` and snapshot | **Unbounded.** Builds the full snapshot to return one thread                                                                                 | `apps/server/src/ws/ws.mobile.ts:120-157`                                                                              |
| Mobile baseline                       | Partially bounded: returns all approval and user-input activities ever recorded                                                              | `ProjectionSnapshotQuery.mobileSql.history.ts:16-121`                                                                  |
| Sidebar pages                         | Bounded, but pages are 5 per project and 20 per section while 4 are shown; "See more" reveals the whole loaded page                          | `constants/sidebar.ts:7`, `Sidebar.inyosira.catalog.ts:28-31`, `SidebarThreadListControls.tsx:32-71`                   |
| Sidebar page order                    | Server pages by `updated_at`; the client sorts by `latestUserMessageAt` or `createdAt`                                                       | `ProjectionCatalogQuery.ts:220-221`, `Sidebar.sort.logic.ts:23-55`                                                     |
| Sidebar catalog and project stats     | Small output, but cost grows with thread count (per-thread subqueries, re-run on every message event)                                        | `ProjectionCatalogQuery.sidebar.ts:28-93`, `ProjectionCatalogQuery.ts:109-145`                                         |
| Client store                          | No eviction of hydrated threads; `mergeThreadDetail` applies no caps; a baseline reset leaves other hydrated threads stale but marked loaded | `stores/main/helpers.lazy.store.ts:92-126`, `mappers.lazy.store.ts:176-217`                                            |
| Activities of older turns             | Only the latest turn's activities load; nothing loads older ones                                                                             | `ProjectionCatalogQuery.detail.activities.ts:44-59`                                                                    |

## Goals

- Reads are bounded by what is on screen, never by database size:
  - opening a thread loads the newest 15 messages;
  - scrolling to the top loads the previous 15;
  - sidebar sections show 4 threads and fetch 4 more at a time.
- No code path the web or mobile clients can reach reads a whole table or the full snapshot.
- Thread retention deletes threads older than the cutoff unless they are genuinely busy, and every run explains what it skipped and why.
- Event history and the command ledgers stay bounded: a hot window plus whatever a live consumer still needs.
- The database file shrinks to match its live content and stays there.
- Attachment files without a live reference are removed after a grace period.
- All background work runs in small batches, yields under load, survives restarts mid-run, and never causes an event-loop stall over 250 ms.

## Non-Goals

- Changing the event-sourcing model or the projection schema.
- Making streamed deltas transient. That needs a contract change; phase 3b only measures whether it is worth doing.
- Retention for notes, Kanban cards or memory files.
- Pruning projection rows of live threads (messages, activities). They are small, and they are the user's data.
- Remote workspace databases; this plan covers the local userdata database.

## Current State

Everything this plan builds on is already in the code:

- **Compaction:** `compactVerifiedPrefix` deletes a baseline-covered prefix in one transaction per batch (1 to 10,000 events). `ProjectionBaselines.ts:198-203` advances `compact_through_sequence` on every verified baseline. Replay already reports `gap` below `retained_through` (`OrchestrationEventStore.ts:296-343`), clients fall back to the bounded bootstrap (`-__root.recovery.ts:208-214`), and startup restores a baseline when a projector cursor lands in a gap (`ProjectionPipeline.ts:204-230`).
- **Retention:** the scheduler (`ThreadRetention.scheduler.ts:17-31`) waits 10 minutes after startup and then runs every 24 hours. Runs page 250 threads at a time and resume after a restart (`ThreadRetention.direct.ts:65-100,211-257`). Deletion goes through `thread.retention-delete` and the unified deletion pipeline. Manual runs use consent challenges (`ThreadRetentionRepository.challenges.ts`).
- **Attachments:** `managed_attachment_ownership` and `managed_attachment_references` (migration 121) gate file deletion. A file is removed only when it is published and its identity and hash still match (`ThreadDeletion.files.ts:142-223`). Files from before migration 121 have no ownership row, so they are kept forever.
- **Bounded reads:** `getSelectedThreadDetail` uses a keyset message cursor on index 054 (`ProjectionCatalogQuery.detail.ts:101-136`). Thread summaries page by keyset (`ProjectionCatalogQuery.ts:198-224`, `.organization.ts:41-57`). The timeline is virtualized (`MessagesTimeline.tsx:131-157`). Live events are buffered during hydration and merged by sequence (`thread-hydration-events.logic.ts:39-80`).
- **Things that read raw events beyond the hot window:**
  - projector bootstrap and reactor catch-up (cursor based);
  - command-ID lookups for undo, deletion recovery and tool readbacks (`OrchestrationEventStore.commandEvents.ts:24-41`).

  Export and handoff read projections (`getFullThreadHistory`), not events.

Behaviour that must not change:

- the out-of-memory fixes of 5–6 November (row-format baselines, sequence-only coverage checks);
- the bounded bootstrap;
- the 4,000-event replay budget;
- the deletion pipeline's ownership and identity checks;
- the attachment hash checks.

## Phases

Phases 0 and 1 change no stored data and can ship first. Phases 2 to 5 delete data. What phase 2 deletes is decided by the user's existing retention settings; phases 3 to 5 remove only internal history, ledgers, free pages and unreferenced files, under the fixed rules in Decisions.

### Phase 0: measurement and explainability (no data change)

1. **Size report script.** Added `scripts/database-size-report.ts`, which opens the database read-only (`mode=ro`) and prints:
   - the per-table and per-index sizes from `dbstat`, free pages and `auto_vacuum`;
   - events by thread state;
   - the retention state, ledger row counts and attachment directory totals.

   It reuses `scripts/connection-health-report.ts`'s argument and output helpers.

2. **Retention diagnostics.** Saved a per-run exclusion breakdown (reason → count, including `blocked_by_descendant`) on `thread_retention_runs`, through a new migration column (`exclusion_counts_json`). Showed it in Settings under the policy, for example "212 older than 3 days · 200 skipped: still marked running".
3. **Preview stays per-thread.** No change: both preview triggers apply per-thread. The scheduled run's own breakdown from step 2 is what explains the stored mode.
4. **Dry run on a copy.** Ran `canonical-event-compaction` dry-run, and the phase 3 compactor, against a copy of the real database to record the expected size after phases 3 and 4.

Exit: the report runs on the real database in under 2 minutes, and Settings shows why the last run selected nothing.

### Phase 1: load only what is needed (no data change)

**1a. Message paging in the thread view**

- Set the first window to 15 messages: `messageLimit: 15` from the open-thread hydrate call (`_chat.$threadId.tsx:137,194`). Keep the contract defaults for other callers.
- Added a top sentinel in `MessagesTimeline` (an IntersectionObserver on the first virtual row, or the virtualizer's range start at 0) that calls `loadOlderThreadMessages({ messageLimit: 15 })`:
  - at most one request in flight per thread;
  - stop when the cursor reports no more messages;
  - show a small top loader and a retry row on error.
- Kept the scroll position steady when the older page is prepended, by measuring the first visible row before the merge and restoring its offset after. This is a separate concern file, `MessagesTimeline.olderPages.ts`.
- Live events still merge by id and order, as today (`mappers.lazy.store.ts:170-230`). A page that overlaps already-loaded messages is deduplicated.
- Added an on-demand activities load for an older turn when its work log is expanded. This needs a new bounded RPC, `getTurnActivities(threadId, turnId, limit)`, backed by index `idx_projection_thread_activities_thread_turn_sequence`.

**1b. Sidebar paging, 4 at a time**

- Set the project and section page size to 4 (`PROJECT_THREAD_SUMMARY_DEFAULT_LIMIT` and the Inyosira page limit). The control becomes "Show 4 more", which fetches the next server page; it no longer reveals a hidden 20-row page.
- Made the server order match the displayed order. Pass the sidebar sort key (`latest_user_message_at` or `created_at`) to the summary queries and page by `(sortKey DESC, thread_id DESC)` keyset. Added matching partial indexes in a migration, with query-plan tests.
- Moved the sidebar catalog's recent-by-activity ordering and `readProjectThreadCounts` onto the existing `projection_threads.latest_user_message_at` column, replacing the per-thread subqueries. Kept the counts in a small cached query, refreshed on change events with the existing 150 ms debounce.

**1c. Remove unbounded snapshot reads from client paths**

- Added a bounded server query `getProjectWorktreePaths(projectId)` (distinct `worktree_path` for that project's live threads, capped at 500). Pointed `Sidebar.remoteWorkspaceAddActions.edit.ts:33` at it.
- Reimplemented `getMobileThread` on `getSelectedThreadDetail`. Capped the mobile baseline's approval and user-input history to the same windows as the desktop detail query.
- Removed `getSnapshot` from the web socket's RPC surface. Kept it on server-internal or CLI paths only, with the export and handoff fallbacks switched to `getFullThreadHistory`. Added a test that fails if any web or mobile module calls `getSnapshot`.

**1d. Size-bounded pages**

A page of 15 messages is bounded by count, not size: one message holding a long tool output or a large diff can still make it heavy. Pages are also bounded by bytes.

- The server stops adding messages to a page once its text exceeds 512 KB, but always returns at least one message. The cursor still points at the next older message, so scroll-up continues normally.
- A single message whose text exceeds 256 KB is returned truncated to its first 64 KB, with `textTruncated: true` and `textLength`. The timeline shows a "Show full message" row that loads the rest through a new bounded RPC, `getMessageTextChunk(threadId, messageId, offset, limit ≤ 256 KB)`, one chunk at a time.
- The same 256 KB rule applies to activity payloads in the detail query and in `getTurnActivities`; truncated payloads carry the same flags.
- Live streaming is unchanged: a message that grows past 256 KB while streaming is truncated in the client store on merge, with the same flag, so the store never holds an unbounded string.
- Copy, export and handoff keep reading the full text through `getFullThreadHistory` or the chunk RPC, never from the truncated store copy.

**1e. Bounded client memory**

- Applied the per-thread caps (`helpers.store.ts:15-18`) inside `mergeThreadDetail`.
- Kept full detail for the 8 most recently viewed threads, and marked the rest unloaded (summary kept), so they re-hydrate on open.
- On a baseline reset, marked every hydrated non-selected thread unloaded.
- Live events for a thread that was never hydrated update only its summary.

Exit: opening any thread requests at most 15 messages, and scrolling up loads 15 more until the start. No client path calls `getSnapshot`. The scale tests from Testing pass.

### Phase 2: unblock thread retention

1. **Runtime reconciliation at startup.** After the startup supervisor finishes its resume probe, mark every `provider_session_runtime` row in `starting`/`running` that has no live adapter session in this process as `stopped`. Keep `resume_cursor_json`, so resume still works, and remove the matching provider leases.
   - This is `ProviderSessionRuntime.reconcile.ts`, called from the same startup step that already clears leases (`ProviderSessionRuntime.ts:112-118`).
   - The same reconcile runs when a turn completes without an active session.
2. **What "running" means to retention.** Changed the `running` exclusion to mean real work:
   - a turn in progress (`projection_thread_sessions.status` in `starting`/`running`, or a non-null active turn);
   - a terminal or shell lease whose process is alive;
   - a computer-use or browser activity lease updated within its expiry.

   A bound but idle provider session no longer excludes a thread; the delete handler already stops it. Kept the trigger guards that block a runtime from starting on a thread being deleted.

3. **Lease hygiene.**
   - Gave `worktree_runtime_leases` and `thread_activity_leases` an `expires_at`. Holders renew it with a heartbeat; the provider lease follows the runtime row.
   - A bounded sweep (100 rows per tick, every 5 minutes) removes leases that are expired, have a NULL PID with no live runtime, or have a dead PID.
   - Learning-job leases for jobs older than 7 days and not running are swept the same way.
4. **Stale tasks.** Tasks left `pending`/`inProgress` on a thread with no active turn for more than 24 hours no longer exclude it. They are marked `stopped` on turn end and on restart.
5. **Selection mode follows the setting.** No automatic migration. A `legacy-subtree` policy keeps subtree cleanup until the user re-picks a policy in Settings › Threads, which already previews, asks for confirmation and switches to `per-thread` (`ThreadRetentionSettingsSection.tsx`, `handlePolicyChange`). This phase only makes sure both modes stop excluding threads for the stale reasons above, and records `blocked_by_descendant` when a legacy subtree is held back by a recent child.
6. **Organisation states.** Unchanged: retention does not look at Present, Needs you, Later or Done, exactly as today. Threads with real work in progress are still excluded by step 2.
7. **Explain every run.** The "Latest cleanup" line in Settings › Threads shows the exclusion breakdown from phase 0 next to the deleted count, so a run that deletes nothing says why. There is no extra confirmation gate: the user's saved policy is the consent, and "Delete now" keeps its existing preview and confirmation.
8. **Soft-deleted rows.** Routed the 248 `deleted_at` rows through the current deletion pipeline as `single`-mode retention deletes, in batches of 25.
9. **Deferred canonical cleanup.** Added an automatic, bounded retry for deletions whose canonical history cleanup was deferred (10 per tick, exponential backoff up to 1 hour, with failures recorded on the run item). This reverses the 2026-08-18 non-goal; see Risks.

Exit: on a copy of the real database, the next run under the saved policy and age rule selects the old idle threads, and Settings shows its exclusion breakdown.

### Phase 3: automatic compaction and ledger pruning

**3a. Background compactor**

Added `apps/server/src/persistence/Layers/EventLogMaintenance.ts` (split into `.floor.ts`, `.ledgers.ts` and `.scheduler.ts`), started from `server.ts`. It calls the existing `compactVerifiedPrefix`; `EntityPurge` is not resurrected.

- **Floor.** The compactor deletes only below `min(...)` of:
  - `compact_through_sequence`, the verified baseline;
  - every projector and reactor cursor;
  - the oldest unacknowledged sequence of any durable delivery session (desktop supervisor, mobile);
  - a hot window: the newest 50,000 sequences, or 24 hours, whichever keeps more;
  - the lowest sequence referenced by open cleanup intents and plans, pending turn starts, the organisation undo window and in-flight project-workspace operations.
- **Batches.** Each tick starts at 1,000 events per batch, one transaction per batch, and yields to the event loop between batches. The batch size adapts so a batch takes 50 ms or less (bounds 100 to 5,000), and each tick has a time budget of 1 second.
- **Load backoff.** The tick is skipped when the SQLite worker queue is deeper than 4, when event-loop lag over the last minute exceeds 100 ms, or while more than 2 turns are streaming. It runs every 2 minutes, and every 15 seconds while a backlog remains.
- **Guaranteed progress.** Backoff alone could starve the compactor during long busy sessions. While a backlog remains and no batch has run for 10 minutes, the next tick runs one minimum batch (100 events, at most 50 ms) even under the soft load signals. Only a hard ceiling skips it: a worker queue deeper than 16, or a batch already in flight. The same guarantee covers ledger pruning (3b) and the attachment sweep (phase 5).
- **Falling behind is visible.** The maintenance state records `backlog`, `lastBatchAt` and a `starved` flag. When the backlog has grown for 24 hours, the size report and Settings › Diagnostics show it as a warning (amber), and the health report counts it.
- **After each batch.** Deletes the gap rows at or below `retained_through_sequence` incrementally.
- **Failure.** The transaction rolls back and the compactor backs off for 15 minutes, matching the coordinator cooldown. A crash mid-batch leaves the database unchanged, and the next tick resumes from `retained_through_sequence`.
- **Progress.** Exposed in the size report and in Settings › Diagnostics as backlog, rate and last error.

**3b. Ledger pruning**

- Receipts and claims with `result_sequence` at or below the floor and older than 7 days are deleted in the same batches. Excluded are commands referenced by:
  - `orchestration_bootstrap_recipes` (a missing receipt means an unfinished bootstrap, `WorktreeLifecycle.preflight.ts:101-103`);
  - the `direct_resource_cleanup_*` tables;
  - project-workspace native operations.
- Claims are always pruned together with their receipt.
- Added an index on `orchestration_event_ids(sequence)` in a migration, then prune rows below `retained_through_sequence`.
- Dropped `idx_orch_events_correlation_id` (540 MB, no reader; `correlationId` always equals `commandId`).
- Measured, on a copy, how many receipts and claims come from provider-ingestion delta commands. Their command IDs embed `randomUUID()` and nothing deduplicates them (`ProviderRuntimeIngestion.processor.runtime.command.ts:3-4`). If they are the majority, a follow-up plan can skip receipt persistence for them or coalesce deltas further. This plan only records the number.

**3c. CLI safety**

- `canonical-event-compaction --apply` now checks `backend.lock` instead of trusting `--server-stopped`.
- It no longer runs `COUNT(*)` after every pass.

Exit: on a copy of the real database, the compactor drains the backlog with no stall over 250 ms in the trace, replay and reconnect behave as today, and the ledgers shrink to the hot window.

### Phase 4: reclaim disk space

1. **One-time rebuild.** Once the phase 3 backlog is drained, set `PRAGMA auto_vacuum = INCREMENTAL` and run one full `VACUUM`. That is required for the pragma to take effect.
   - Trigger: a "Compact database" action in Settings › Threads, next to "Delete eligible threads now", offered when free pages exceed 25% and 500 MB. It follows the same pattern as that row: a preview of the expected size, then a confirmation.
   - Preconditions: free disk of at least the current file size, and no running turns.
   - The backend enters a maintenance state with a full-panel bigbud loader while it runs. `VACUUM` is atomic, so an interrupted run leaves the old file intact.
2. **Steady state.**
   - The maintenance tick runs `PRAGMA incremental_vacuum(2048)`, about 8 MB, when free pages exceed 10%.
   - It runs `PRAGMA wal_checkpoint(TRUNCATE)` when idle.
   - It sets `journal_size_limit` to 64 MB.

Exit: the file size tracks live content within about 10%.

### Phase 5: attachments

1. **Ownership backfill.** Recorded ownership (device, inode, hash) for files from before migration 121 that a live thread references, in batches of 25, so normal thread deletion can remove them.
2. **Orphan sweep.** Files in `attachments/` with no row in `projection_thread_attachment_refs` or `managed_attachment_references`, older than a 7-day grace period, are moved to `attachments/.trash/`. They are deleted after another 7 days, 50 files per tick.
   - Staged uploads are skipped through the existing 5-minute reconcile (`managedAttachmentOwnership.ts:41-93`).
   - Names are validated against the attachment ID pattern, so nothing outside the managed layout is touched.
3. **Same cutoff as threads.** Attachments have no separate age setting. They leave with their thread when retention or a manual delete removes it, through the existing ownership and hash checks (`ThreadDeletion.files.ts`), so the thread retention setting is also the attachment cutoff.

Exit: the orphan count in the size report reaches zero after the grace period, with no live reference broken.

## Risks And Decision Gates

- **First run after phase 2 deletes many threads.** With the saved 3-day policy, the first working run would delete about 200 threads, 162 of them in Later. That is what the setting asks for, so there is no extra gate, but the release notes and the "Latest cleanup" line must make it visible. Anyone who wants a longer period should change it in Settings › Threads before updating.
- **Background compaction rewrites history automatically.** This was deferred twice: the 2026-08-18 recovery plan and phase 5 of the 2026-11-05 plan. The user has now asked for automatic removal. The floor rules make it safe for every known consumer, but an unknown consumer that reads old events by sequence would see a `gap`. Every known one handles that, except the internal reactor stream, which dies on a gap (`OrchestrationEngine.domainEvents.ts:35-36`). The floor includes reactor cursors for exactly that reason, and a test asserts it.
- **VACUUM needs disk and time.** It needs free disk equal to the file size and blocks writes for minutes on 8.7 GB, though seconds once compacted. That is why it is a confirmed Settings action rather than a silent startup step.
- **Load.** All maintenance shares the single SQLite worker. Batches are adaptive and skipped under pressure; the trace and the health report verify there is no new stall.
- **Downgrade.** Compacted events cannot come back. An older build starting on a compacted database restores from the verified baseline, which is the existing path. The new columns and indexes are additive.
- **Ordering with uncommitted work.** New migrations must take numbers after the highest committed migration at implementation time; currently that is 152.

## Testing And Validation

| Layer               | Test                                                                     | Proves                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server, persistence | `ProviderSessionRuntime.reconcile.test.ts`                               | Stale `running` rows become `stopped` at startup, the resume cursor is kept, provider leases are removed, and a live session is untouched                                       |
| Server, retention   | `ThreadRetentionRepository.runningSemantics.test.ts`                     | An idle bound session does not exclude a thread; an active turn, a live-PID lease or an unexpired activity lease does; organisation state has no effect                         |
| Server, retention   | `ThreadRetention.settingsDriven.test.ts`                                 | Scheduled runs use the saved policy, age rule and selection mode; a `legacy-subtree` policy stays subtree until changed in Settings; no extra confirmation is raised            |
| Server, retention   | `ThreadRetentionRepository.exclusionCounts.test.ts`                      | Saved breakdown matches the selector; `blocked_by_descendant` is counted                                                                                                        |
| Server, persistence | `EventLogMaintenance.floor.test.ts`                                      | Floor is the minimum of baseline, cursors, delivery acks, hot window and referenced sequences; a lagging reactor holds compaction back                                          |
| Server, persistence | `EventLogMaintenance.batches.test.ts`                                    | Adaptive batch stays at or under its budget; skipped under worker-queue pressure; crash mid-batch is a no-op; resumes from `retained_through`                                   |
| Server, persistence | `EventLogMaintenance.ledgers.test.ts`                                    | Receipts referenced by bootstrap recipes, cleanup tables and workspace operations survive; claims are pruned with receipts; `event_ids` pruning uses the new index (query plan) |
| Server, integration | `EventLogMaintenance.replay.test.ts`                                     | A client replaying from below `retained_through` gets `gap` and recovers through the bounded bootstrap; the desktop replay budget is unchanged                                  |
| Server, persistence | `EventLogMaintenance.progress.test.ts`                                   | Under constant soft pressure a minimum batch still runs every 10 minutes while a backlog remains; the hard ceiling skips it; a growing backlog sets `starved`                   |
| Server, queries     | `ProjectionCatalogQuery.detail.byteBudget.test.ts`                       | A page stops at 512 KB but returns at least one message; a message over 256 KB is truncated with flags; `getMessageTextChunk` returns the rest in bounded chunks                |
| Server, scale       | `EventLogMaintenance.scale.test.ts`                                      | 200,000 synthetic events drain with the longest batch at or under 50 ms and bounded memory                                                                                      |
| Server, attachments | `AttachmentOrphanSweep.test.ts`                                          | Real filesystem: orphans move to trash after the grace period and are deleted later; referenced, staged and non-pattern files are untouched                                     |
| Server, queries     | `ProjectionCatalogQuery.sortedPages.test.ts`                             | Keyset pages by `latest_user_message_at` and `created_at` match the client order and use the new indexes                                                                        |
| Server, queries     | `ProjectionCatalogQuery.sidebar.scale.test.ts`                           | Sidebar catalog and project stats at 10,000 threads stay under a fixed time budget                                                                                              |
| Server, RPC         | `getProjectWorktreePaths.test.ts`, `ws.mobile.bounded.test.ts`           | Bounded results; `getMobileThread` no longer builds a snapshot                                                                                                                  |
| Web, unit           | `MessagesTimeline.olderPages.test.ts`                                    | One request in flight, stop at start, retry on error, dedupe on overlap, scroll anchor kept                                                                                     |
| Web, unit           | `MessagesTimeline.truncatedMessage.test.ts`                              | A truncated message shows "Show full message" and loads chunks; a streaming message past 256 KB is truncated in the store                                                       |
| Web, unit           | `mappers.lazy.store.caps.test.ts`, `helpers.lazy.store.eviction.test.ts` | Caps apply on merge; least-recently-viewed eviction; reset marks threads unloaded                                                                                               |
| Web, guard          | `noUnboundedSnapshot.test.ts`                                            | No web or mobile module calls `getSnapshot` or `getMobileThread`                                                                                                                |
| Web, browser        | `MessagesTimeline.olderPages.browser.tsx`, `Sidebar.paging.browser.tsx`  | Scrolling to the top loads 15 older messages with no jump; "Show 4 more" fetches the next 4 in display order                                                                    |
| Manual, real data   | Copy of `state.sqlite`                                                   | Size report before and after phases 3 and 4; health report shows no new stalls over a 2-hour multi-thread session                                                               |

Use the commands in `AGENTS.md`: focused Vitest through `bun run --cwd <pkg> vitest run <files>`, `bun run --cwd apps/web test:browser <file>`, scoped `oxfmt`/`oxlint`, package typechecks, and the 400-line limit on every touched file. Never run `bun test`; full-suite runs need approval.

## Acceptance Criteria

- Opening a thread requests 15 or fewer messages. Scrolling to the top loads 15 more per step until the first message, without a visible scroll jump.
- Sidebar projects and sections show 4 threads, and "Show 4 more" fetches the next 4 from the server, in the same order as displayed.
- No web or mobile path calls `getSnapshot`, and a guard test enforces it.
- No message page exceeds 512 KB of text plus one message, and no single message or activity payload in the client store exceeds 256 KB unless the user expanded it.
- The retention run after phase 2 selects old idle threads according to the saved Settings › Threads policy and age rule, and the "Latest cleanup" line explains every skip.
- After phase 3 on the real database, `orchestration_events` holds only the hot window plus floor-protected events, and receipts, claims, event IDs and gaps are bounded the same way.
- After phase 4, the file is within about 10% of its live content. Expected under 1.5 GB from 8.7 GB, to be confirmed by the phase 0 dry run.
- No maintenance batch exceeds 50 ms. While a backlog remains, at least one batch runs every 10 minutes even under load, and a backlog that grows for 24 hours is reported. The health report shows no increase in event-loop stalls or long SQL spans versus the phase 4 baseline of the 2026-11-05 plan.
- Orphaned attachment files are removed after the grace period, and no referenced file is removed.

## Decisions

Thread retention choices are the user's existing Settings › Threads controls, not new questions:

- **Retention period and age rule:** the saved policy (currently 3 days) and age rule (currently last conversation activity).
- **Per-thread or subtree:** the saved selection mode. Legacy subtree stays until the user re-picks a policy, which already previews and confirms the switch to per-thread.
- **Confirmation:** the existing preview and confirmation on policy changes and "Delete now". Scheduled runs need no extra prompt.
- **Organisation sections:** unchanged; retention ignores them, as today.
- **Attachments:** follow their thread, so the thread setting is their cutoff. Files no thread references are swept after a 7-day grace period.

Internal rules this plan fixes, with no user setting:

- **Raw history window:** the newest 50,000 events or 24 hours, whichever keeps more. It affects only undo and internal readbacks.
- **Disk reclaim:** a confirmed "Compact database" action in Settings › Threads when free space is large, then small automatic incremental vacuums.

## Implementation Status (7 November, 2026)

All phases are implemented in the working tree and pass focused checks. Nothing is committed, and none of it has run in the app yet.

**Migrations:** 153 (retention exclusion counts), 154 (sidebar paging indexes), 155 (lease expiry, deferred-cleanup retries, and the `orchestration_event_ids(sequence)` index pulled forward from 3b), 156 (event-log maintenance state; drops `idx_orch_events_correlation_id`), 157 (one-time backfill of usage attribution onto `projection_turns`), 158 (orphan-claim pruning cursor).

**Measured on copies of the real database:**

- Phase 2: the next scheduled run under the saved policy selects 128 roots (169 threads), where it selected 0 before.
- Phases 3 and 4: the event log drains in about 18 minutes. 6 of 199,224 worker holds exceeded 50 ms (p99 12.2 ms), and 4 of those coincided with disk fsync stalls. Peak WAL during the drain was 4 MB. The file goes from 8.28 GB to 920.9 MB after an 8.1 s rebuild.
- Phase 5: 7 orphaned files (3.6 MB) are due for trash, and 57 legacy files (17.2 MB) are due for ownership backfill.

**Deviations from the phases above:**

- **1b:** no cached count query; uncached it takes about 5 ms at 10,000 threads.
- **1c:** the mobile web app still calls `getMobileThread` and `getSnapshot`, now bounded on the server.
- **1d:** a fully expanded long message renders as plain text.
- **2.4:** stale tasks are stopped only after 24 hours idle.
- **2.8:** soft-deleted rows go through proof-checked canonical cleanup directly, because the retention delete path skips deleted threads.
- **2.9:** canonical cleanup deletes in 500-event chunks.
- **3a, receipt batches:** batches are capped by receipt count in `(result_sequence, rowid)` order. Whole sequence groups of up to 24,462 no-op receipts used to cause 600 ms commits.
- **3a, maintenance timing:** batch sizes carry over between ticks, and the organisation undo window is 7 days.
- **3b, orphan claims:** claims with no receipt are pruned after 7 days in separate bounded passes.
- **3, usage attribution:** usage attribution no longer reads raw events (migration 157).
- **4:** incremental vacuum runs 1,024 pages per step, not 2,048 (15–19 ms against 34–35 ms). The compaction overlay is mounted at the app root.
- **5:** the attachment tick also removes empty `.submission-upload-*` directories older than 1 day. The upload code no longer leaves them behind.

**Open:**

- **Durability (decided 7 November, 2026):** the writer connection now runs `synchronous = NORMAL` (`Sqlite.ts`). In WAL mode commits stay atomic and the file cannot corrupt, but a power loss or OS crash can lose the commits since the last checkpoint. This removes the per-commit fsync behind the remaining 50 ms+ stalls.
- **Live verification:** the scheduler loop, retention deletes and the Settings rows still need to run in the app. The health report should then be compared with the 2026-11-05 baseline.
- **Restored baselines:** a verified baseline taken before migration 157 and restored after compaction would show legacy turns as "unknown".

## Follow-ups

These came out of the 7 November review and are deliberately not fixed yet.

- **Fixed: auto-increment `row_id` broke baseline replay.** Baseline turn rows used to include `projection_turns.row_id`, so a gap in `sqlite_sequence` (the real database has one: 3,635,507 against `max(row_id)` 3,635,489) made every later candidate fail with "normalized replay hash mismatch". Capture now leaves `row_id` out (`PROJECTION_BASELINE_SURROGATE_KEYS`), restore replaces `projection_turns` whole and lets SQLite assign ids, and migration 158 rewrites and rehashes every verified baseline (`rehashVerifiedBaselinesWithoutTurnRowIds`) and drops unverified candidates. `ProjectionBaselines.turnRowIds.test.ts` replays across a sequence gap and checks the hashes match.

- **Fixed: who verifies baselines.** Only deletion paths used to capture and verify baselines, so a quiet stretch with no deletions left the newest baseline holding the floor. Event-log maintenance now asks the projection pipeline to verify one itself (`EventLogMaintenance.baselineRefresh.ts`) when the `baseline` holder keeps the floor at least 10,000 sequences below every other holder. It does this only on full-mode (idle) ticks, at most once an hour, and through the same single-flight coordinator the deletion paths use. A failure is logged and the tick keeps the old floor.

- **Fixed: tool retries after events are compacted.** Policy: a receipt is kept no longer than its events. Receipt pruning dropped its 7-day minimum age and now removes a receipt (with its claim) once `result_sequence` is at or below `min(floor, retained_through_sequence)`. A retry finds either both or neither. Events are kept at least 24 hours, so ordinary retries still deduplicate; a retry after its events are compacted runs as a new command. Orphan claims keep their 7-day in-flight guard.
- **Batch sizing under write load:** the `wal_checkpoint(PASSIVE)` after each batch counts WAL frames written by other writers or pinned by a long reader. The sizer treats them as the batch's own cost, so under write load every batch size can drop to the minimum of 100 and draining slows to a crawl.
- **Cost of skipped ticks:** a `skip-soft` tick still reads the whole floor (about 25 statements, including a `projection_threads` scan with `json_valid`) and writes the state row, every 15 seconds while the app is busy.
- **Minimum mode:** the guaranteed-progress minimum runs one batch of each of the five kinds plus five checkpoints, not the single minimum batch the plan describes.
- **Receipt cursor:** the receipt cursor moves past receipts that are kept on purpose. When the reason to keep one ends (for example a bootstrap finishes), that receipt and its claim are never pruned. The orphan pass only covers claims without a receipt. It is a small but permanent leak.
- **Attachment ticks during backoff:** while event-log maintenance backs off after a failure (15 minutes), full attachment ticks stop too, so a recurring event-log error leaves attachments one 50 ms tick every 10 minutes.
- **Upload folders that still hold a file:** a crash between writing an upload and removing its folder leaves the full upload on disk, because maintenance only removes empty folders.
- **Hot-window clock assumption:** the 24-hour hot-window search assumes `occurred_at` rises with sequence. It often comes from a command's `createdAt` (client clock), so a client with a slow clock shortens the 24-hour extension. The 50,000-sequence window is unaffected.
- **Attachment holds query cost:** the unresolved-reference branch of the holds query runs `instr` over each unresolved message or activity JSON once per ID in the chunk. Each attachment tick also lists and sorts the whole attachments folder on the event loop. Neither is bounded by the 50 ms target.
- **One-time startup cost:** migrations 155 (`CREATE INDEX` on `orchestration_event_ids(sequence)`) and 156 (`DROP INDEX` on a large index) each block startup for a few seconds, once, on a database the size of the 8 GB one.
- **Usage cache:** `wsRpcHandlers.usage.cache.ts` runs a shared lookup in the first caller's fiber, so callers waiting on it inherit that caller's interruption. If the first window closes during a multi-second query, the second window's request fails (a retry works). The cache also keeps the first connection's lookup closure alive for the life of the query object.
- **Migration 157 field mixing:** provider and model are backfilled independently, so a turn can get a provider from one source and a model from another. Interaction mode comes only from the top-level `$.interactionMode`, and only rows missing a provider or model are filled.
