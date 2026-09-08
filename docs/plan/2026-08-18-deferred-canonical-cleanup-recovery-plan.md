# Deferred Canonical Cleanup Recovery Plan

**Date:** 18 August, 2026
**Status:** Implemented; verification pending
**Owner:** bigbud team

## Summary

Provide a bounded, operator-invoked recovery for threads whose projection was deleted but whose canonical-history cleanup was deferred after replacement-baseline verification failed. Reuse deletion markers as the durable indicator; do not create a purge job, retry worker, or retention queue.

## Progress

Phase 1 is implemented in `CanonicalThreadCleanup.ts`. Candidate selection is bounded and reports both fully covered and deferred roots; apply mode finalizes only fully covered roots, while uncovered roots remain untouched and are reported as skipped. The existing direct deletion path and bounded `canonical-thread-cleanup` support CLI reuse the same canonical finalization operation. The CLI requires an explicit bounded `--limit` and `--server-stopped` for apply mode.

## Related Work

- [Thread Deletion Remaining Work Plan](2026-08-18-thread-deletion-remaining-work-plan.md), step 4.
- None identified for an existing maintenance-command abstraction. The only server CLI command currently starts the server (`apps/server/src/cli/cli.ts`).

## Problem

`processDeletionRequested` finalizes the projection and then calls `finalizeCanonicalHistory` (`apps/server/src/orchestration/Layers/ProviderCommandReactorHandlers.delete.ts:232-255`). When replacement-baseline verification fails, it logs `thread canonical history cleanup deferred` and preserves the deletion markers plus canonical rows. The marker is durable, but no path subsequently selects that marker for cleanup.

`ProjectionBaselineRepository.markVerified` marks every eligible deletion marker covered by the verified sequence (`apps/server/src/persistence/Layers/ProjectionBaselines.ts:289-324`). `verifyCanonicalPurgeProof` already rejects unverified or incomplete subtrees (`apps/server/src/deletion/Layers/EntityPurge.proof.ts:7-33`), and the canonical SQL already replaces deleted event sequences with sparse gaps and deletes the matching identity, event-ID, stream-state, receipt, and marker rows (`apps/server/src/deletion/Layers/EntityPurge.sql.ts:400-513`). These are sufficient durable state and cleanup primitives; a new maintenance record would duplicate them.

## Goals

- Let an administrator explicitly retry only covered, deferred thread canonical cleanups.
- Keep failed verification non-blocking for direct deletion and retention.
- Bound each invocation and report scanned, finalized, still-unverified, and failed counts.
- Preserve sparse-gap replay behavior.

## Non-Goals

- No general purge queue, background retry loop, startup sweep, or new durable job table.
- No changes to cascades, direct thread deletion sequencing, legacy-purge retirement, providers, or normal retention UI/results.
- No cleanup of uncovered markers or resources.

## Current State

- The verify-only pipeline operation intentionally creates and verifies a replacement baseline without global prefix compaction (`apps/server/src/orchestration/Layers/ProjectionPipeline.ts:155-164`). Candidate failures are rejected and the original verification error is retained (`apps/server/src/orchestration/Layers/ProjectionPipeline.baseline.ts:20-78`).
- The existing direct canonical test proves canonical deletion creates event gaps and restart replay restores only retained threads (`apps/server/src/orchestration/Layers/ProviderCommandReactor.canonicalDeletion.test.ts:17-117`).
- Existing manual recovery durability is limited to retired `purge_jobs`, whose automatic resumption is disabled (`apps/server/src/persistence/Migrations/079_RetireIncompletePurgeJobs.ts:7-17`); it is not appropriate for new canonical cleanup.
- Existing user-visible maintenance reporting is retention-specific (`packages/contracts/src/server/threadRetention.ts:35-105`) and describes old runs, not canonical cleanup. Do not overload it.
- The bounded cleanup module and read-only/apply CLI subcommand now exist in `apps/server/src/deletion/Layers/CanonicalThreadCleanup.ts` and `apps/server/src/cli/cli.ts`; remaining work is validation and runbook hardening.

## Phases

### Phase 1: Extract bounded canonical cleanup

Extract the nested `finalizeCanonicalHistory` operation into a focused server module/service shared by direct deletion and recovery. Keep its order unchanged: verify a replacement baseline, verify the marker proof in a transaction, delete receipts, then invoke the existing sparse-gap canonical deletion.

Add a SQL selector that returns distinct root markers for thread deletion subtrees that are fully covered by a verified baseline, ordered by deletion sequence and limited by a required bounded limit. It must return no uncovered or partially covered subtree.

The recovery operation must process those roots sequentially, isolate each root failure, and return counts plus root IDs/error detail suitable for operator logs. It must not create any durable progress record: successful cleanup removes its markers, and a failed root remains selected by a later explicit invocation.

### Phase 2: Add an explicit support command

Add a dedicated administrator/support CLI subcommand only after choosing a CLI command composition pattern. It should require an explicit `--limit`, use the normal persistence and projection layers, and run the bounded recovery once before exiting. It must not start the HTTP/WebSocket server or schedule background work.

Report a concise terminal summary: scanned, finalized, deferred because no verified coverage, and failed. Keep user-facing deletion and retention results unchanged; direct deletion should continue to log a deferred canonical cleanup warning with the root ID.

The command defaults to read-only inspection. Applying cleanup requires `bigbud canonical-thread-cleanup --apply --server-stopped`; stop the bigbud desktop app and server before running it.

### Phase 3: Document operation

Extend the existing purge recovery runbook with backup, server-shutdown/one-writer, dry-run, invocation, output, and retry guidance. State that a failed invocation leaves canonical history untouched for that root and requires another explicit operator run after the baseline issue is fixed.

## Risks And Decision Gates

- There is no existing admin/support command or generic maintenance-record abstraction. Adding a CLI subcommand and its layer bootstrapping is a new public shape, so confirm its command name, required `--limit`, and whether a `--dry-run` mode is mandatory before implementation.
- Do not select markers merely because one marker is covered: the entire deletion-sequence subtree must be covered, matching `verifyCanonicalPurgeProof`.
- Do not call normal `ensureVerifiedBaselineThrough`, because it can compact the global prefix. Recovery must use the existing verify-only operation.
- Recovery must be single-writer with normal server persistence. Document stopping the server unless the selected command obtains the same exclusive runtime ownership.

## Testing And Validation

- Focused validation is pending because the working-tree migration loader is being modified concurrently and currently references migration modules that are not present in this checkout.

- Add a focused canonical-cleanup test: force verify-only baseline failure, assert projection deletion succeeds and canonical rows/markers remain, then run recovery after verification succeeds and assert sparse gaps plus removal of receipts, event IDs, stream state, identities, and markers.
- Add a mixed-root test: one fully covered root finalizes while an uncovered or failing root remains intact and is reported without preventing the other root.
- Add a restart/replay assertion after recovery: retained threads restore and recovered deleted threads do not.
- Add CLI parsing/required-limit and dry-run tests once the command interface is approved.
- Run only focused server Vitest files plus targeted typecheck/lint for changed packages; do not run full tests or repo-wide formatting for this investigation.

## Acceptance Criteria

- A deferred deletion has no new queue/job row and does not affect later direct deletion.
- An explicit bounded recovery finalizes only fully baseline-covered marker subtrees using the existing proof and sparse-gap cleanup.
- A failed root remains recoverable by another explicit invocation, with no automatic retry.
- Operator output distinguishes finalized, deferred, and failed roots; ordinary user-visible retention reporting remains unchanged.

## Open Questions

- Should recovery require the server to be stopped, or should the new command own the same persistence lifecycle exclusively?
- Is `--dry-run` required for the first production operation, or is a required small `--limit` plus backup/runbook gate sufficient?
