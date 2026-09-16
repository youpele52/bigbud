# Next Projection Thread-Ownership Group

**Date:** 18 August, 2026  
**Scope:** Follow-up audit for the incremental ownership migrations.

## Recommendation

Migrations 081–089 are now present in the working tree and cover the projection messages,
activities, sessions, tasks, state rows, attachment references, turns, runtime/auxiliary rows,
watches, and delegations. The next bounded cleanup slice is to finish the write contract for
**`projection_thread_proposed_plans`** and remove its redundant explicit delete. Its owned
`thread_id` is rebuilt as:

```sql
thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE
```

The migration must first remove historic rows without a `projection_threads` parent, preserve
`idx_projection_thread_proposed_plans_thread_created`, and verify `foreign_key_check` and
`integrity_check`. It must not add an FK to `implementation_thread_id`: that nullable
cross-thread provenance field has no established null-on-source-deletion contract.

`projection_thread_attachment_refs` is the next smallest table by writer surface, but not the
next group: its `WITHOUT ROWID` layout and six source-table triggers make it a separate trigger
rebuild after proposed plans.

## Parent-write and fixture contract

The task contract is now present: `ProjectionThreadTaskRepository.upsert` calls
`assertProjectionThreadParent`, and migration 082's focused test covers cleanup, artifacts, and
cascade. Projector ordering is not sufficient because projectors run in separate transactions.

`ProjectionThreadProposedPlanRepository.upsert` now uses the same parent assertion, with focused
repository coverage proving that a plan cannot be written before its projection parent. Current
direct SQL fixtures in catalog detail, operational state, and snapshot queries seed projection
thread parents. Historical migration fixtures remain historical inputs.

`046_ProjectionThreadTasks.test.ts` remains an explicit pre-migration fixture: it intentionally
creates activity rows without projection parents before migration 046 and must not be changed.

## Audited tables

| Table                               | Owned FK readiness                                                          | Parent/write requirement                                                                                                                                                                        | Optional reference or trigger semantics                                                                                                                                                                                       | Group decision                                                            |
| ----------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `projection_thread_tasks`           | Ready; migration 082 exists.                                                | Parent assertion and focused repository coverage are present.                                                                                                                                   | No optional thread reference.                                                                                                                                                                                                 | Completed prior step; full-suite/replay validation still gates expansion. |
| `projection_thread_proposed_plans`  | Ready; migration 083 exists and the repository parent assertion is present. | Focused parent-order and cascade coverage added.                                                                                                                                                | Preserve nullable `implementation_thread_id` without an FK or new nulling behavior.                                                                                                                                           | **Completed bounded slice.**                                              |
| `projection_turns`                  | Not ready.                                                                  | Assert in both turn write paths and checkpoint upsert; audit raw checkpoint/catalog/retention fixtures.                                                                                         | `source_proposed_plan_thread_id` is nullable and direct deletion nulls it with `source_proposed_plan_id`; any FK requires explicit `ON DELETE SET NULL` tests. Migration 065 also has a deleting-source trigger.              | Defer.                                                                    |
| `projection_pending_approvals`      | Not ready.                                                                  | Add parent assertion; confirm direct catalog/retention fixtures seed parents. Migration 023 remains historical pre-FK input.                                                                    | Nullable `turn_id` has no ownership policy.                                                                                                                                                                                   | Defer; do not combine with tasks or proposed plans.                       |
| `projection_pending_user_inputs`    | Not ready.                                                                  | Add parent assertion; existing repository coverage seeds a parent, while raw retention/EntityPurge fixtures need a focused gap check.                                                           | Nullable `turn_id` has no ownership policy.                                                                                                                                                                                   | Defer.                                                                    |
| `projection_usage_contributions`    | Not ready.                                                                  | Assert in contribution upsert; the replay test currently writes a contribution before a parent and must seed one. Migration 045 is historical repair input.                                     | `activity_id` and nullable `turn_id` are not owned FKs; adding either changes activity/revert retention behavior.                                                                                                             | Defer.                                                                    |
| `projection_thread_attachment_refs` | Separate later rebuild.                                                     | No direct application writer: message/activity triggers derive rows from already parent-checked source rows. Migration 070 historical rows must remain parentless and bounded at migration 070. | `attachment_id = ''` is a valid unresolved sentinel; attachment storage is shared and must not receive an FK/cascade. Preserve `WITHOUT ROWID`, the lookup index, and all six message/activity insert/update/delete triggers. | Defer until its trigger-specific migration test is isolated.              |

## Required rebuild artifacts for later groups

Every ownership migration must delete historic orphans first, snapshot/restore table artifacts, and
run both SQLite integrity checks. Specifically:

- proposed plans: preserve the thread-created index and every column, including nullable
  implementation provenance;
- turns: preserve indexes and the migration-065 retention trigger without changing source-plan
  nulling semantics;
- pending rows: preserve thread/status/created indexes and leave nullable `turn_id` policy
  unchanged;
- usage: preserve all three contribution indexes; keep `projection_usage_backfill_state` outside
  the child rebuild and do not add activity/turn FKs;
- attachment refs: preserve `WITHOUT ROWID`, the lookup index, unresolved `attachment_id = ''`,
  and exact trigger behavior for insert, malformed/unresolved payloads, update, and delete.
  Attachment bytes remain outside the projection ownership cascade.

## Migration 070 / 081 ordering

The first migration-070 test is a historical upgrade test and must run through migration 70 only,
leaving deliberately parentless source rows and derived references visible for its assertions.
The current-write test runs all migrations and seeds `thread-a` through `thread-e` parents. Do not
seed parents in the historical test.

## Blockers

1. The 081–089 migration set still needs full server-suite and restart/replay validation; focused
   migration tests are not release validation.
2. Pending approvals, pending user inputs, and usage contributions still need parent-write audits
   before their explicit deletion inventory can be reduced further.
3. Turns retain nullable source-plan provenance without a foreign key; its nulling contract needs
   a separate migration/restart test before that relationship is changed.

## Explicit exclusions

Do not include `projection_threads.parent_thread_id`, canonical state, legacy recovery records,
attachment storage, or direct provider code in the next group. Watches, delegations, and the
runtime tables are already migrated but remain gated by the validation above.
