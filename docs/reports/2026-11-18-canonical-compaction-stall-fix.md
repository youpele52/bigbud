# Canonical compaction stall after project cascades (2026-11-18)

**Follows:** "Found live, not fixed" in
[linux/arm64 deletion fix](2026-11-18-linux-arm64-deletion-fix.md).

## Symptom

After a project delete cascaded its threads, the backend logged
`ensureBaseline:postcondition … did not reach requested sequence 10` every 5 s, also after a
restart. The verified baseline stayed at 6 while every projector and the frontier were at 16.
Cascade, project and retention cleanup plans stayed `ready`, so canonical events, provider logs,
notes and kanban were never reclaimed.

## Root cause

Neither suspicion was the cause. The required projector list matches `projection_state`, and
projection replay is deterministic. The cause is a race between two baseline coordinators, made
worse by a failure cooldown that ignores coverage that already exists.

1. **Two unsynchronised verifiers.** `ProjectionPipeline.ts:163` (compacting, used by
   `EntityPurge` preflights) and `ProjectionPipeline.ts:167` (verify-only, used by canonical
   cleanup, the 5 s cleanup recovery loop and event-log maintenance) each have their own
   single-flight. Both called `verifyThrough` / `compact` (`ProjectionPipeline.baseline.ts:85`
   and `:92` before the fix) at the same time.
   - `createCandidate` returns the existing row for the same sequence
     (`ProjectionBaselines.ts:97-101`). Both flights verify the same candidate in the same
     workspace file (`ProjectionPipeline.baseline.workspace.ts:114`, keyed by `baselineId`).
   - The compacting flight deletes the verified prefix (`ProjectionPipeline.baseline.ts:95`)
     while the other flight is still replaying it. That flight fails with `verify:retainedGap`.
   - The failing flight rejects the shared candidate (`ProjectionPipeline.baseline.ts:57`). If
     the other flight has not marked it verified yet, the row is deleted. Its `markVerified`
     then updates no row, so no baseline exists and the result is the logged `postcondition`.
     It also still marked deletions covered and advanced `compact_through_sequence`
     (`ProjectionBaselines.ts:177-211`).
   - In some orders, the two flights blocked each other on the shared workspace and never
     finished (seen in the experiment, more than 2 minutes).
2. **Stale failure replay.** `ProjectionPipeline.baseline.coordination.ts:54` checked the
   15-minute cooldown before checking coverage (`:66`). After one lost race, a coordinator
   replayed the same error, still naming sequence 10, to every caller for 15 minutes. That
   included requests the other coordinator had already covered. After the restart, the recovery
   loop and the purge preflight raced again, and the 4-minute observation fell inside one
   cooldown.

## Fix

- `ProjectionPipeline.baseline.ts`: one semaphore serialises candidate creation, verification
  and compaction for both coordinators (`verifyThrough` and `compact`).
- `ProjectionPipeline.baseline.coordination.ts`: coverage is checked before the cooldown.
  The cooldown still stops repeated verification of an uncovered request; it no longer fails a
  request that a verified baseline already covers.
- `ProjectionBaselines.ts` `markVerified`: updates the row by `baseline_id` and `sequence`, with
  `RETURNING`, and fails when the row is gone. It never records coverage or a compaction target
  for a rejected candidate. This tightens a safety condition; none is weakened.

## Project cascade resources (`directResources: []`)

`629e906213` added a `project-cascade` branch that skipped thread file discovery, terminal
history cleanup and worktree recovery for cascaded threads. The commit is unrelated to deletion
and gives no reason. Project discovery (`ProjectDeletion.files.ts`) covers only notes and kanban,
so the cascaded threads' provider logs, managed attachments, terminal history and managed
worktrees were never cleaned. This is a leak, not a design choice. The cascade now uses the
direct delete path unchanged (`ProviderCommandReactorHandlers.delete.ts`): the same
`threadDeletion.discoverFiles`, with its ownership checks and retained or shared resources, and
the same terminal and worktree cleanup.

## Tests

- `ProjectionPipeline.baseline.race.test.ts` (new):
  - An engine-driven project cascade with overlapping verify-only and compacting requests. Both
    succeed and every deletion marker ends up covered.
  - No cooled-down failure is replayed once coverage exists.
  - `markVerified` refuses a candidate that was rejected meanwhile.
  - All three fail on the original code. The second fails with the live message,
    `did not reach requested sequence 10`.
- `ProviderCommandReactor.projectCascadeResources.test.ts` (new): a project delete removes the
  cascaded parent's and child's provider logs and keeps unrelated logs. It times out on the
  original handler.
- `ProjectionPipeline.baseline.cooldown.test.ts`: during cooldown the coordinator now reads the
  coverage sequence (cheap) but still does not re-verify.
