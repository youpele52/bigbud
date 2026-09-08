# Thread Foreign-Key Ownership Matrix

**Date:** 18 August, 2026  
**Scope:** Incremental projection-only ownership migration.

## Evidence and boundary

The authoritative deletion inventory is `apps/server/src/deletion/Layers/EntityPurge.sql.ts`:
`countThreadRows`, `deleteThreadDependents`, `deleteOrphanRows`, and the checkpoint query module.
The schema sources are the persistence migrations, while the production-write and fixture audit is the
repository/projector SQL plus direct test inserts. A relation is **not** migration-ready merely because
the direct delete inventory currently removes it.

`projection_threads(thread_id)` is a projection parent, not a universal thread identity. In particular,
runtime, retention, canonical, and fixture workflows legitimately create rows while no projection row is
present. This is why the previous all-table rebuild was invalid.

## Matrix

| Table / column(s)                                                                                                                                                                       | Classification                                             | Evidence / deletion behavior                                                                                   | FK posture                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `projection_thread_messages.thread_id`                                                                                                                                                  | exclusive projection ownership                             | Projector/repository writes it for a projected thread; direct delete and orphan cleanup remove it.             | Implemented in migration 081 as `ON DELETE CASCADE`.                                                       |
| `projection_thread_activities.thread_id`                                                                                                                                                | exclusive projection ownership                             | Same projection lifecycle; direct delete and orphan cleanup remove it.                                         | Implemented in migration 081 as `ON DELETE CASCADE`.                                                       |
| `projection_thread_sessions.thread_id`                                                                                                                                                  | exclusive projection ownership                             | One projected session per thread; direct delete and orphan cleanup remove it.                                  | Implemented in migration 081 as `ON DELETE CASCADE`.                                                       |
| `projection_thread_tasks.thread_id`                                                                                                                                                     | exclusive projection ownership                             | Projected task rows; direct delete and orphan cleanup remove them.                                             | Candidate cascade; migration/retention fixtures insert tasks alone.                                        |
| `projection_thread_proposed_plans.thread_id`                                                                                                                                            | exclusive projection ownership                             | Projected plan rows; direct delete and orphan cleanup remove them.                                             | Candidate cascade only after fixture parent contract is repaired.                                          |
| `projection_turns.thread_id`                                                                                                                                                            | exclusive projection ownership                             | Projected turns; direct delete and orphan cleanup remove them.                                                 | Candidate cascade only after fixture parent contract is repaired.                                          |
| `projection_pending_approvals.thread_id` / `projection_pending_user_inputs.thread_id`                                                                                                   | exclusive projection ownership                             | Projected pending work; direct delete and orphan cleanup remove it.                                            | Candidate cascade, but pending-input/approval migration fixtures are parentless.                           |
| `projection_usage_contributions.thread_id`                                                                                                                                              | exclusive projection ownership                             | Derived projection rows; direct delete and orphan cleanup remove them.                                         | Candidate cascade only after repair/backfill fixtures establish parents.                                   |
| `projection_thread_attachment_refs.thread_id`                                                                                                                                           | exclusive projection ownership with shared asset semantics | Reference row belongs to the thread; attachment bytes can be shared and are handled separately.                | Candidate cascade for the reference row, not for attachment storage.                                       |
| `projection_threads.parent_thread_id`                                                                                                                                                   | optional self-reference                                    | Direct delete currently nulls surviving children; subtree deletion removes descendants.                        | `ON DELETE SET NULL` only after parent/subtree semantics and parent-cycle preflight are explicitly tested. |
| `projection_turns.source_proposed_plan_thread_id`                                                                                                                                       | optional source reference                                  | Direct delete nulls it and its plan ID rather than deleting the turn.                                          | `ON DELETE SET NULL`; not a first group.                                                                   |
| `projection_thread_watches.watcher_thread_id`, `watched_thread_id`                                                                                                                      | relationship row                                           | Direct delete removes a watch when either endpoint is deleted.                                                 | Two nullable/cascade endpoints require an explicit relationship migration; not a first group.              |
| `thread_delegations.caller_thread_id`, `child_thread_id`                                                                                                                                | relationship/cross-project record                          | Direct delete removes either endpoint; also has project references.                                            | Requires both-endpoint policy and project interaction review.                                              |
| `automation_schedules.target_thread_id`, `automation_runs.thread_id`                                                                                                                    | operational ownership                                      | Direct delete removes schedules/runs; schedules have independent project/automation lifecycle.                 | No thread FK until automation write contract is redesigned.                                                |
| `provider_session_runtime.thread_id`                                                                                                                                                    | operational runtime record                                 | Direct delete only removes stopped rows and explicitly fences active runtime.                                  | No FK: runtime can outlive/precede a projection row during recovery.                                       |
| `worktree_runtime_leases.thread_id`, `thread_activity_leases.thread_id`                                                                                                                 | operational lease                                          | Browser, terminal, shell, and computer-use production writes create leases independently of projection writes. | No FK.                                                                                                     |
| `checkpoint_diff_blobs.thread_id`                                                                                                                                                       | operational/checkpoint record                              | Explicit cleanup after runtime safety checks.                                                                  | No FK until checkpoint retention ownership is redesigned.                                                  |
| `learning_jobs.thread_id`, `skill_change_proposals.thread_id`                                                                                                                           | operational/background record                              | Explicit cleanup; jobs can be queued independently of a current projection.                                    | No FK.                                                                                                     |
| `orchestration_events.stream_id`, `orchestration_command_receipts.aggregate_id`, `orchestration_stream_state.stream_id`, `orchestration_thread_identity.thread_id`, deletion-marker IDs | canonical / sparse-retention state                         | Targeted canonical cleanup is baseline-proven and uses sparse gaps.                                            | No projection FK; canonical history must remain replay-safe independently.                                 |
| `purge_jobs.entity_id`, purge claims/checkpoints                                                                                                                                        | legacy recovery                                            | Manual-recovery manifests must remain readable after current projection deletion.                              | No FK.                                                                                                     |

## Parentless-write audit

### Production writes that rule out an initial FK

- `browser/Layers/BrowserManager.ts`, `browser/Layers/VisibleBrowserControl.ts`,
  `computer-use/Layers/ComputerUse.ts`, `terminal/Layers/Manager.ts`, and
  `shell/Layers/ThreadShellRunner.ts` insert runtime leases by thread ID without creating a
  `projection_threads` parent.
- Provider runtime, checkpoint, automation, learning, canonical event, and legacy purge paths use a
  thread ID as an operational identity rather than a projection ownership key.

### Fixture audit result

Current-era retention, catalog, operational-state, snapshot, pending-user-input, and EntityPurge
fixtures seed a matching `projection_threads` row through their local `seedThread`/setup helpers before
inserting one of these three children. The shared `ProjectionThread.test.helpers.ts` helper is available
for any new isolated fixture.

Two migration tests deliberately create historical orphan rows before the migration under test:

- `persistence/Migrations/046_ProjectionThreadTasks.test.ts` validates task backfill from an older
  activity-only schema.
- `persistence/Migrations/070_ThreadAttachmentReferences.test.ts` validates attachment-reference
  backfill from malformed historical message/activity payloads.

They must remain explicit pre-migration bypass fixtures; adding a current projection parent would hide the
historical migration input. The query/search result also confirms parentless inserts for runtime leases,
checkpoint blobs, automation rows, watches, delegations, and learning jobs. Those are operational or
relationship fixtures, not candidates for this projection-only FK group.

## Staged migration plan

1. **Repair write contracts first.** Add a shared projection-thread fixture helper and update every
   projection-only fixture to create its parent. Confirm projectors/repositories never write a child
   before the parent in production.
2. **Completed: preflight and one projection-only group.** Migration 081 deletes historic orphan rows,
   rebuilds messages, activities, and sessions with `thread_id REFERENCES projection_threads(thread_id)
ON DELETE CASCADE`, restores valid indexes and triggers, and runs `foreign_key_check` plus
   `integrity_check`. The parent-write contract and current-era fixtures are now covered by focused tests.
3. **Validate before the next group.** Run the full server suite without a command timeout and a restart
   replay check against migration 081 before expanding the ownership surface.
4. **Audit the next projection-only group independently.** Tasks, proposed plans, turns, pending rows,
   usage contributions, and attachment references must each establish fixture/write contracts and define
   their optional-reference behavior before a separate migration.
5. Treat self-references, relationship rows, and operational/canonical/legacy tables as separate design
   work. Do not add them to a projection-child rebuild.

## Decision

Migration 081 implements the first narrow group. Do not expand it until its full-suite and restart replay
validation complete. The two explicit pre-migration orphan fixtures remain unchanged so their historical
migration inputs stay meaningful.
