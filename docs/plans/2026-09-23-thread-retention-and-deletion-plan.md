# Cross-Platform Thread Retention and Cleanup Plan

**Date:** 23 September, 2026

**Status:** Proposed — implementation-ready; no application changes made

**Owner:** Implementation owner unassigned

## Summary

Make manual and automatic thread cleanup reliable on supported platforms. New runs choose **Created** or **Last conversation activity**, delete eligible threads individually, preserve pinned and otherwise ineligible children, account for managed resources, and show durable progress in one concise toast. Existing enabled automatic policies retain their current root-subtree behavior until the user explicitly opts into the new behavior.

## Related Work

- Prior cleanup and recovery designs: [server-owned immediate deletion](2026-08-18-server-owned-immediate-thread-deletion-plan.md), [deferred canonical cleanup](2026-08-18-deferred-canonical-cleanup-recovery-plan.md), and [Rust resource cleanup executor](2026-08-29-rust-resource-cleanup-executor-plan.md).
- The user's September 2026 manual cleanup exposed delayed cleanup-plan recovery, an external worktree link that trapped one deletion, and attachments omitted from the planned resource manifest. No issue, bigbud note, or Kanban reference was supplied.

## Problem

Today's retention policy selects entire root subtrees based on the latest user message of any descendant. A recent or pinned child can protect an otherwise old parent. The manual RPC waits for the run instead of returning a durable progress handle, and disappearance of a thread can precede canonical pruning and physical resource cleanup. Resource discovery can miss files and rejects worktree paths outside bigbud's managed root; a rejected path can leave a deletion pending. Simply installing per-thread selection would also broaden existing automatic policies without renewed consent.

## Goals

- Offer exactly two criteria for new manual and automatic runs: **Created** (`projection_threads.created_at`) and **Last conversation activity** (latest user-message `created_at`, or thread creation when none exists). Assistant/tool messages, `updated_at`, and `last_activity_at` do not advance the second criterion.
- Keep current periods (`never`, 1, 2, 3, 7, 14, 30, 90 days), a fixed UTC cutoff, and eligibility **on or before** that cutoff (`<=`). Preview, queued estimate, selection, and claim must use the same criterion and boundary.
- Process eligible children before eligible parents; never delete a pinned, newer, active, or otherwise excluded descendant merely because its ancestor qualifies. Detach surviving children safely.
- Finish or truthfully report canonical and managed-resource cleanup after restarts and reconnects. Use platform-independent server-owned logic, not the temporary macOS cleanup script.
- Show one run-keyed progress toast immediately, every five minutes while active even if counts do not change, and immediately on a warning or terminal result. Keep messages to one line.

## Non-Goals

- No literal “Last modified”/`updated_at` option, any-role-message age definition, deletion of remote provider conversations, arbitrary source/project directories, or filename-based filesystem sweeps.
- Do not delete unmanaged or remote worktrees. Do not assume legacy files with missing ownership evidence have been physically cleaned.
- Do not change existing enabled automatic policies to per-thread semantics without explicit user consent.

## Current State

- `apps/server/src/persistence/Layers/ThreadRetentionRepository.eligibility.ts` defines conversation activity as the most recent **user** message, falling back to creation. `ThreadRetentionRepository.pages.ts`, `.preview.ts`, and `.claim.ts` apply it to root subtrees; migration `060_ProjectionCatalogUserMessageIndex.ts` indexes the user-message lookup. `ThreadRetentionRepository.visible.test.ts` verifies that metadata-only `last_activity_at` changes do not extend eligibility.
- `ThreadRetentionRepository.queue.ts:createQueuedRun` currently estimates eligibility with `t.last_activity_at`, contradicting preview and selection.
- `apps/server/src/orchestration/deciderThreads.lifecycle.ts` and `deletion/Services/ThreadDeletion.ts` support single-thread deletion. `persistence/Layers/ProjectionThreads.ts` detaches surviving children; the canonical deletion tests check projection rebuild.
- `apps/server/src/deletion/Layers/ThreadDeletion.files.ts` discovers message/activity attachments and managed logs, but fails on worktrees outside the managed root. Projection attachment references alone do not prove ownership of every managed upload, especially after deletion.
- `apps/server/src/retention/Layers/ThreadRetention.direct.ts` uses a two-minute settle timeout and may mark a logical deletion complete before its direct cleanup plan finishes. `apps/web/src/components/settings/ThreadRetentionSettingsSection.tsx` shows a static loading toast until its long-running RPC returns.

## Phases

### Phase 1: Preserve legacy policy semantics and persist opt-in

Add the next unused SQLite migration after the existing migration 120, and register it in `apps/server/src/persistence/Migrations.ts`. Recheck numbering and preserve unrelated work before editing. Extend policy authority and run/challenge persistence with `selection_mode` (`legacy-subtree | per-thread`) and `age_criterion` (`created | last-conversation-activity`). Backfill **existing enabled** automatic policies and accepted runs as `legacy-subtree` / `last-conversation-activity`; keep their periods, cutoffs, cursors, items, retry state, and historical counts intact. `never` remains disabled. Old scheduled and queued runs must continue to use the old selector/command after an upgrade.

Update `packages/contracts/src/core/settings.threadRetention.ts`, `packages/contracts/src/server/threadRetention.ts`, server settings/authority, and retention consent paths. A user changing or enabling automatic cleanup must preview and explicitly consent to the new per-thread semantics, period, and criterion. Scheduled runs snapshot all three values when created; switching the saved policy cannot reinterpret accepted runs. Keep the administrative `BIGBUD_DISABLE_THREAD_RETENTION` gate and existing single-use consent protection. **Exit:** migration and restart tests prove that deployment alone does not change any enabled legacy policy's selection.

### Phase 2: Share one age expression and bound selection

Add criterion-specific SQL in `ThreadRetentionRepository.eligibility.ts`: `t.created_at` or the existing `retentionVisibleActivitySql("t")`. Reuse it in `.queue.ts`, `.pages.ts`, `.preview.ts`, and `.claim.ts` for all **new per-thread** runs. Show thread counts (not root counts) and rename preview's oldest/newest fields to indicate the selected age. The initial queued estimate is provisional; final counts derive from persisted item outcomes. Remove `.queue.ts`'s `t.last_activity_at` shortcut. Bind criterion, period, and fixed cutoff to preview and consent.

Page by `(selected_timestamp, thread_id)` with a persisted mode/version-aware cursor; never read a legacy subtree cursor as a per-thread cursor. Atomically recheck the expected timestamp, `<=` cutoff, pin, active/pending-work and project exclusions, and run ownership before dispatch; record a reasoned skip when the state changed. Check query plans on representative multi-project data with `EXPLAIN QUERY PLAN`; reuse the user-message index and add a creation-time index if measurement warrants it. **Exit:** preview, queue, paging, and claim agree at and around the boundary and after restart.

### Phase 3: Per-thread execution and safe hierarchy handling

In `retention/Layers/ThreadRetention.direct.ts`, `orchestration/Layers/OrchestrationEngine.commandProcessing.ts`, lifecycle/fence handling, and the deletion reactor, retain legacy subtree dispatch **only** for legacy runs. New runs dispatch idempotent, run-owned **single-thread** deletion requests via normal `ThreadDeletion` preflight and `ProviderCommandReactorHandlers.delete.ts`. Schedule eligible children before eligible parents across page boundaries with persisted dependency deferrals rather than an unbounded in-memory thread list. Do not add excluded children to a parent's deletion set.

Reuse `ProjectionThreads.ts`'s transactional child detachment when an eligible parent has surviving children. Remove the blanket nonlocal-target exclusion for new runs, but retain runtime, resource ownership, and other fail-closed checks; remote threads do not authorize remote filesystem removal. **Exit:** mixed-age, pinned, active, cross-project and remote cases preserve the right threads and child links after canonical pruning and projection rebuild.

### Phase 4: Prove resource ownership and prevent stuck worktree deletions

Introduce durable, projection-independent records for managed attachment creation (ID, validated relative path, creator, file identity, lifecycle) and indexed multi-thread references. Identify all managed write paths, including normal uploads and computer-use screenshots; register staged ownership idempotently before/with creation and reconcile interrupted writes. At deletion, combine verified ownership with actual message/activity manifests and **live** references before claiming exclusive cleanup. Keep identity-bound, symlink-safe direct cleanup. Where legacy ownership cannot be established from durable evidence and manifests, record an unverified/blocked outcome; do not guess from filename prefixes. Distinguish removed, already absent, retained-shared, pending and unverified resources in plan/results.

Replace `ThreadDeletion.files.ts`'s error on an external or remote worktree path with a durable `retained_external` classification. Never capture or delete that directory; finalize the thread with a visible retained-resource outcome. Changed identity, overlap, or unsafe traversal **inside** a managed root still fails closed and recovers/retries or aborts via `thread.delete.abort`. Update intent/plan persistence and startup recovery so a stuck `deletingAt` can resolve without manual DB edits. **Exit:** uploads, missing/shared files, external paths, managed-path races and restart tests all produce truthful outcomes without touching unrelated files.

### Phase 5: Persist logical and physical completion separately

Associate each run item durably with its command, deletion-request event, cleanup intent, operation and proof. Reconcile uncertain dispatch/finalization from receipts and plans. Track logical selected/requested/finalized/skipped/uncertain counts separately from removable resources completed, retained resources, blocked resources, and canonical-pruning state. A two-minute wait is a polling boundary, not a terminal failure; restart or DB-busy delays remain pending with bounded retries. Mark success only when every selected thread has a proven terminal outcome and all expected removable resources have terminal evidence; disclose retained-external, shared, blocked and unverified outcomes instead of claiming that all files were deleted.

Change manual start in `ThreadRetention.ts` to return a persisted run ID promptly; server work must outlive the originating WebSocket. Expose authenticated `getRun` and bounded `listRecentRuns` methods through server RPC handlers, contracts, and web native API. **Exit:** ambiguous receipt, slow baseline, delayed resource cleanup, reconnect and restart tests keep monotonic counts and never report premature success.

### Phase 6: Finish Settings and progress UX

In `ThreadRetentionSettingsSection.tsx`, `ThreadRetentionConfirmationContent.tsx` and their logic, expose the two criteria for new manual and opted-in automatic policies. Clearly label an existing enabled automatic policy “Legacy subtree cleanup—review to change”; do not silently display it as a newly selected per-thread policy. Preview explains the age definition, all-project scope, `<=` cutoff, surviving children, excluded items, retained external worktrees, and estimate limits. Changing period or criterion invalidates its challenge and requests a fresh preview.

Show one loading toast keyed by run ID; poll persisted progress for the Settings view, updating that toast every five minutes while active (including unchanged counts) and immediately for warning/final states. Keep one-line severity-appropriate copy, e.g. “Cleanup: 84/291 threads deleted · resources pending.” Rehydrate after remount/reconnect without duplicate success toasts; show a reconnection state rather than a false failure. Automatic runs remain observable through recent-run history without generating unsolicited manual-run toasts. **Exit:** browser tests cover long runs, timer cadence, accessibility, remount and socket loss.

## Risks And Decision Gates

- **Release gate:** Ship the legacy-mode migration and test it with enabled policies before enabling per-thread scheduling. Accepted legacy runs must always retain their original semantics; disabling new scheduling must not erase accepted cleanup intents.
- File provenance may be missing for historical uploads. Preserve unknown files and report incomplete cleanup rather than infer ownership. A staged/partial upload must never authorize deletion of another thread's file.
- A recorded external worktree is a retained resource, not deletion authority. Never disable path guards globally to resolve a stuck thread. Retry or abort uncertain managed-path operations through orchestration.
- Monitor canonical pruning, SQLite contention, cleanup backlog and blocked resources. Roll back new scheduling with `BIGBUD_DISABLE_THREAD_RETENTION=1` while keeping recovery active; committed deletions cannot be undone.

## Testing And Validation

- Contract/migration tests: exact two criterion values, consent binding, enabled legacy policy, nonterminal legacy runs, never-policy behavior, authority rollback and restart.
- Server tests: criterion-consistent preview/queue/pages/claim (`<=` cutoff, ties and changed activity), child-before-parent, pinned/active/newer descendants, automation/project ownership, remote targets, external and changed managed paths, attachment registration/ref sharing, proof-linked resource recovery, DB-busy and ambiguous finalize.
- Web/browser tests: two selectors, challenge expiry on changes, succinct five-minute toast updates even without count changes, immediate terminal updates, reconnect/remount, run identity and honest counts.
- Run focused Vitest suites, then `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` (**never `bun test`**). If Rust changes, run `cargo fmt --all --check`, `cargo clippy --locked --workspace --all-targets -- -D warnings`, and `cargo test --locked --workspace`. Validate macOS, Windows, Linux and long-running desktop/web sessions. Keep each materially edited source/test file at most 400 lines.

## Acceptance Criteria

- Existing automatic policies and accepted runs continue selecting the same legacy root subtrees until explicit opt-in; new policies/runs use exactly the chosen criterion and per-thread semantics.
- At a fixed cutoff, preview, queue estimate, selection and claim agree; no `updated_at`/`last_activity_at` shortcut affects either criterion.
- No pinned or ineligible child is deleted, no surviving child has a missing parent, and remote/unmanaged directories are never traversed or deleted.
- Every selected run item has a persisted, reconcilable logical outcome; every expected removable resource has a verified terminal outcome before full success. Shared, retained, unverified and blocked resources are reported truthfully.
- A manual run continues after UI disconnect; one-line progress appears every five minutes and immediately when it finishes or needs attention, without duplicate toasts.

## Open Questions

None blocking. The confirmed product choices are two age criteria, opt-in per-thread automatic cleanup, a five-minute progress cadence, and fail-closed treatment of unverified files.
