# Donna-kukama Thread Purge Recovery Runbook

**Date:** 17 August, 2026  
**Status:** Approved pending backup decision and server shutdown

## Purpose

This runbook is a targeted administrative recovery for every thread associated with `/Users/youpele/DevWorld/donna-kukama` in the local bigbud state database. It is a direct SQLite and filesystem operation, not a supported in-app workflow.

## Confirmed Scope

Two retained project records resolve to the target workspace:

```sh
DB="$HOME/.bigbud/userdata/state.sqlite"
ATTACHMENTS_DIR="$HOME/.bigbud/userdata/attachments"
TARGET_PROJECT_IDS="'da01bc40-1daa-4ab4-af9b-32f1a861431e', '4da4a961-d0dd-41e9-b4d8-42f8673cd2b5'"
```

Preflight on 17 August, 2026 found:

- `da01bc40-1daa-4ab4-af9b-32f1a861431e`: 2 threads.
- `4da4a961-d0dd-41e9-b4d8-42f8673cd2b5`: 3 threads.
- 105 messages, 1,114 activities, 28 turns, 5 sessions, and 1 attachment reference.
- No project notes, learning jobs, skill-change proposals, or project memory files.

The operation retains both `projection_projects` rows. It does not delete project notes, project memory directories, global memory, or user memory.

## Safety Gates

1. Stop the desktop app and server before touching the database. Do not operate on a live SQLite database.
2. Create and verify a consistent backup of the complete state database and state directories. If free disk space cannot hold a complete backup, do not proceed without explicit user authorization to accept permanent data loss.
3. Re-run the preflight and ensure exactly the two IDs above still resolve to the expected workspace and exactly five target threads remain.
4. Do not run `VACUUM` or the global orphan-row cleanup from the original recovery runbook.

## Preflight

```sh
sqlite3 "$DB" "
SELECT project_id, title, workspace_root
FROM projection_projects
WHERE project_id IN ($TARGET_PROJECT_IDS)
ORDER BY project_id;

SELECT project_id, COUNT(*) AS thread_count
FROM projection_threads
WHERE project_id IN ($TARGET_PROJECT_IDS)
GROUP BY project_id
ORDER BY project_id;
"
```

Confirm no target thread has active runtime state before the purge:

```sh
sqlite3 "$DB" "
SELECT 'provider_session_runtime', COUNT(*)
FROM provider_session_runtime
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id IN ($TARGET_PROJECT_IDS))
UNION ALL SELECT 'provider_turn_liveness', COUNT(*)
FROM provider_turn_liveness
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id IN ($TARGET_PROJECT_IDS))
UNION ALL SELECT 'worktree_runtime_leases', COUNT(*)
FROM worktree_runtime_leases
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id IN ($TARGET_PROJECT_IDS))
UNION ALL SELECT 'thread_activity_leases', COUNT(*)
FROM thread_activity_leases
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id IN ($TARGET_PROJECT_IDS));
"
```

All four counts must be `0`.

## Database Purge

Execute only after the safety gates pass. This transaction deletes target-thread state while retaining project records and project-level metadata.

```sql
BEGIN IMMEDIATE;

DELETE FROM automation_runs
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id IN ('da01bc40-1daa-4ab4-af9b-32f1a861431e', '4da4a961-d0dd-41e9-b4d8-42f8673cd2b5'));
DELETE FROM automation_schedules
WHERE target_thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id IN ('da01bc40-1daa-4ab4-af9b-32f1a861431e', '4da4a961-d0dd-41e9-b4d8-42f8673cd2b5'));
DELETE FROM projection_thread_watches
WHERE watcher_thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id IN ('da01bc40-1daa-4ab4-af9b-32f1a861431e', '4da4a961-d0dd-41e9-b4d8-42f8673cd2b5'))
   OR watched_thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id IN ('da01bc40-1daa-4ab4-af9b-32f1a861431e', '4da4a961-d0dd-41e9-b4d8-42f8673cd2b5'));
DELETE FROM thread_delegations
WHERE caller_thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id IN ('da01bc40-1daa-4ab4-af9b-32f1a861431e', '4da4a961-d0dd-41e9-b4d8-42f8673cd2b5'))
   OR child_thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id IN ('da01bc40-1daa-4ab4-af9b-32f1a861431e', '4da4a961-d0dd-41e9-b4d8-42f8673cd2b5'));
UPDATE projection_threads
SET parent_thread_id = NULL, parent_thread_title = NULL, parent_thread_project_id = NULL
WHERE parent_thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id IN ('da01bc40-1daa-4ab4-af9b-32f1a861431e', '4da4a961-d0dd-41e9-b4d8-42f8673cd2b5'));
UPDATE projection_turns
SET source_proposed_plan_thread_id = NULL, source_proposed_plan_id = NULL
WHERE source_proposed_plan_thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id IN ('da01bc40-1daa-4ab4-af9b-32f1a861431e', '4da4a961-d0dd-41e9-b4d8-42f8673cd2b5'));

DELETE FROM learning_jobs WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id IN ('da01bc40-1daa-4ab4-af9b-32f1a861431e', '4da4a961-d0dd-41e9-b4d8-42f8673cd2b5'));
DELETE FROM skill_change_proposals WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id IN ('da01bc40-1daa-4ab4-af9b-32f1a861431e', '4da4a961-d0dd-41e9-b4d8-42f8673cd2b5'));
DELETE FROM checkpoint_diff_blobs WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id IN ('da01bc40-1daa-4ab4-af9b-32f1a861431e', '4da4a961-d0dd-41e9-b4d8-42f8673cd2b5'));
DELETE FROM projection_usage_contributions WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id IN ('da01bc40-1daa-4ab4-af9b-32f1a861431e', '4da4a961-d0dd-41e9-b4d8-42f8673cd2b5'));
DELETE FROM projection_pending_approvals WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id IN ('da01bc40-1daa-4ab4-af9b-32f1a861431e', '4da4a961-d0dd-41e9-b4d8-42f8673cd2b5'));
DELETE FROM projection_pending_user_inputs WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id IN ('da01bc40-1daa-4ab4-af9b-32f1a861431e', '4da4a961-d0dd-41e9-b4d8-42f8673cd2b5'));
DELETE FROM projection_turns WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id IN ('da01bc40-1daa-4ab4-af9b-32f1a861431e', '4da4a961-d0dd-41e9-b4d8-42f8673cd2b5'));
DELETE FROM projection_thread_sessions WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id IN ('da01bc40-1daa-4ab4-af9b-32f1a861431e', '4da4a961-d0dd-41e9-b4d8-42f8673cd2b5'));
DELETE FROM projection_thread_tasks WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id IN ('da01bc40-1daa-4ab4-af9b-32f1a861431e', '4da4a961-d0dd-41e9-b4d8-42f8673cd2b5'));
DELETE FROM projection_thread_proposed_plans WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id IN ('da01bc40-1daa-4ab4-af9b-32f1a861431e', '4da4a961-d0dd-41e9-b4d8-42f8673cd2b5'));
DELETE FROM projection_thread_attachment_refs WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id IN ('da01bc40-1daa-4ab4-af9b-32f1a861431e', '4da4a961-d0dd-41e9-b4d8-42f8673cd2b5'));
DELETE FROM projection_thread_activities WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id IN ('da01bc40-1daa-4ab4-af9b-32f1a861431e', '4da4a961-d0dd-41e9-b4d8-42f8673cd2b5'));
DELETE FROM projection_thread_messages WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id IN ('da01bc40-1daa-4ab4-af9b-32f1a861431e', '4da4a961-d0dd-41e9-b4d8-42f8673cd2b5'));
DELETE FROM orchestration_thread_identity WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id IN ('da01bc40-1daa-4ab4-af9b-32f1a861431e', '4da4a961-d0dd-41e9-b4d8-42f8673cd2b5'));
DELETE FROM projection_threads WHERE project_id IN ('da01bc40-1daa-4ab4-af9b-32f1a861431e', '4da4a961-d0dd-41e9-b4d8-42f8673cd2b5');

COMMIT;
```

## Attachment Cleanup

After the transaction commits, delete an attachment file only when no remaining attachment-reference row uses its filename ID. Review the selected files before deletion.

## Validation

```sql
SELECT project_id, COUNT(*) AS remaining_threads
FROM projection_threads
WHERE project_id IN ('da01bc40-1daa-4ab4-af9b-32f1a861431e', '4da4a961-d0dd-41e9-b4d8-42f8673cd2b5')
GROUP BY project_id;

PRAGMA integrity_check;
```

Expected results are zero threads for both project IDs and `ok` from the integrity check.
