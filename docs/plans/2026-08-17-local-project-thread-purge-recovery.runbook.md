# Local Project Thread Purge Recovery Runbook

**Date:** 17 August, 2026
**Status:** Completed one-time operation
**Related record:** [Local project thread purge recovery](2026-08-17-local-project-thread-purge-recovery.md)

## Purpose

This is the operational handoff for the direct local recovery performed on the bigbud project at `/Users/youpele/DevWorld/bigbud`. It captures the commands used to identify, purge, and validate project thread state and attachment files.

The original interactive terminal transcript was not retained. The destructive SQL below is an execution-equivalent reconstruction from the completed operation and the [current purge implementation](../../apps/server/src/deletion/Layers/EntityPurge.sql.ts#L220-L261). It must not be represented as a supported application workflow.

## Deferred Canonical Cleanup

If a normal deletion reports deferred canonical-history cleanup, stop the bigbud server and desktop app before running the bounded maintenance command. Inspection is the default:

```sh
bigbud canonical-thread-cleanup --limit 10
```

After taking a consistent backup and confirming single-writer access, apply only the inspected bounded batch:

```sh
bigbud canonical-thread-cleanup --limit 10 --apply --server-stopped
```

The command processes only roots covered by a verified replacement baseline. A failed root remains untouched and can be retried after the baseline problem is fixed; this command is never required for new thread deletion.

## Scope And Safety

```sh
DB="$HOME/.bigbud/userdata/state.sqlite"
ATTACHMENTS_DIR="$HOME/.bigbud/userdata/attachments"
PROJECT_ID="1c4f7525-6e2b-4c23-b079-4052a36d0f4c"
```

- Target project path: `/Users/youpele/DevWorld/bigbud`.
- The project row was intentionally retained.
- The operation removed 862 threads and their dependent state.
- The operation removed attachment files only when no remaining row in `projection_thread_attachment_refs` referenced the attachment ID.
- Stop bigbud before touching the database or attachment directory. Do not run these commands against a live server.
- This is irreversible. A database backup was attempted before the completed operation but failed due to insufficient disk space; the purge then proceeded at the user's direction without a rollback copy.
- Do not run `VACUUM` during a space-constrained recovery. It can require substantial extra disk space.

## Read-Only Preflight

Identify the local project and count its threads before deleting anything:

```sh
sqlite3 "$DB" "
SELECT project_id, title, workspace_root
FROM projection_projects
WHERE project_id = '$PROJECT_ID';

SELECT COUNT(*) AS target_thread_count
FROM projection_threads
WHERE project_id = '$PROJECT_ID';
"
```

Count the main dependent records. The completed operation observed 49,990 messages, 401,892 activities, 2,436 attachment references, 6,079 turns, and 829 thread sessions before deletion:

```sh
sqlite3 "$DB" "
SELECT 'projection_thread_messages' AS table_name, COUNT(*) AS row_count
FROM projection_thread_messages
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = '$PROJECT_ID')
UNION ALL
SELECT 'projection_thread_activities', COUNT(*)
FROM projection_thread_activities
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = '$PROJECT_ID')
UNION ALL
SELECT 'projection_thread_attachment_refs', COUNT(*)
FROM projection_thread_attachment_refs
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = '$PROJECT_ID')
UNION ALL
SELECT 'projection_turns', COUNT(*)
FROM projection_turns
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = '$PROJECT_ID')
UNION ALL
SELECT 'projection_thread_sessions', COUNT(*)
FROM projection_thread_sessions
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = '$PROJECT_ID');
"
```

List target attachment IDs before deleting the attachment-reference rows. The completed operation found 1,632 distinct IDs, of which 212 files existed locally:

```sh
sqlite3 "$DB" "
SELECT DISTINCT attachment_id
FROM projection_thread_attachment_refs
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = '$PROJECT_ID')
  AND attachment_id <> '';
"
```

## Destructive Database Purge

This transaction removes only state belonging to threads in the target project. It deliberately does not delete `projection_projects`, project notes, or the project's other metadata. `purge_jobs`, canonical orchestration events, and command receipts are also not included because they were not part of the completed direct projection cleanup.

```sql
BEGIN IMMEDIATE;

-- Clear runtime rows first. This assumes bigbud is stopped.
DELETE FROM provider_session_runtime
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = :project_id);
DELETE FROM provider_turn_liveness
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = :project_id);
DELETE FROM worktree_runtime_leases
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = :project_id);
DELETE FROM thread_activity_leases
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = :project_id);

-- Remove cross-thread references before thread-owned rows.
DELETE FROM automation_runs
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = :project_id);
DELETE FROM automation_schedules
WHERE target_thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = :project_id);
DELETE FROM projection_thread_watches
WHERE watcher_thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = :project_id)
   OR watched_thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = :project_id);
DELETE FROM thread_delegations
WHERE caller_thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = :project_id)
   OR child_thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = :project_id);
UPDATE projection_threads
SET parent_thread_id = NULL,
    parent_thread_title = NULL,
    parent_thread_project_id = NULL
WHERE parent_thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = :project_id);
UPDATE projection_turns
SET source_proposed_plan_thread_id = NULL,
    source_proposed_plan_id = NULL
WHERE source_proposed_plan_thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = :project_id);

-- Remove target-thread state.
DELETE FROM learning_jobs
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = :project_id);
DELETE FROM skill_change_proposals
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = :project_id);
DELETE FROM checkpoint_diff_blobs
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = :project_id);
DELETE FROM projection_usage_contributions
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = :project_id);
DELETE FROM projection_pending_approvals
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = :project_id);
DELETE FROM projection_pending_user_inputs
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = :project_id);
DELETE FROM projection_turns
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = :project_id);
DELETE FROM projection_thread_sessions
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = :project_id);
DELETE FROM projection_thread_tasks
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = :project_id);
DELETE FROM projection_thread_proposed_plans
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = :project_id);
DELETE FROM projection_thread_attachment_refs
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = :project_id);
DELETE FROM projection_thread_activities
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = :project_id);
DELETE FROM projection_thread_messages
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = :project_id);
DELETE FROM orchestration_thread_identity
WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = :project_id);

-- Delete the target thread roots last. The project row remains.
DELETE FROM projection_threads
WHERE project_id = :project_id;

COMMIT;
```

To execute the SQL above, replace `:project_id` with the quoted target value, save it in a temporary file outside the repository, and run:

```sh
sqlite3 "$DB" < /path/to/project-thread-purge.sql
```

The completed operation additionally deleted already-orphaned rows that referenced no `projection_threads` row. This cleanup is global to the local database, not limited to the target project, and must be used only after inspecting its impact:

```sql
BEGIN IMMEDIATE;
DELETE FROM projection_thread_messages
WHERE thread_id NOT IN (SELECT thread_id FROM projection_threads);
DELETE FROM projection_turns
WHERE thread_id NOT IN (SELECT thread_id FROM projection_threads);
DELETE FROM provider_session_runtime
WHERE thread_id NOT IN (SELECT thread_id FROM projection_threads);
DELETE FROM provider_turn_liveness
WHERE thread_id NOT IN (SELECT thread_id FROM projection_threads);
DELETE FROM orchestration_thread_identity
WHERE thread_id NOT IN (SELECT thread_id FROM projection_threads);
COMMIT;
```

## Attachment File Cleanup

Run this only after the database transaction commits. It first builds the live attachment ID set from all remaining threads and then deletes files whose filename ID is absent. It matches the completed cleanup's policy: never delete a file merely because its original target thread was deleted if another thread still references it.

```sh
DB="$DB" ATTACHMENTS_DIR="$ATTACHMENTS_DIR" python3 - <<'PY'
from pathlib import Path
import os
import sqlite3

db_path = os.environ["DB"]
attachments_dir = Path(os.environ["ATTACHMENTS_DIR"])

with sqlite3.connect(db_path) as connection:
    referenced_ids = {
        row[0]
        for row in connection.execute(
            "SELECT DISTINCT attachment_id "
            "FROM projection_thread_attachment_refs "
            "WHERE attachment_id <> ''"
        )
    }

orphan_paths = [
    path
    for path in attachments_dir.iterdir()
    if path.is_file() and "." in path.name and path.name.rsplit(".", 1)[0] not in referenced_ids
]

print(f"referenced IDs: {len(referenced_ids)}")
print(f"orphan files: {len(orphan_paths)}")
for path in orphan_paths:
    print(path)

# Uncomment only after reviewing the printed paths.
# for path in orphan_paths:
#     path.unlink()
PY
```

The completed cleanup deleted 282 no-longer-referenced files. Afterward, 202 attachment files remained on disk; all were referenced by remaining attachment-reference rows.

## Post-Operation Validation

Verify the target has no remaining threads, then validate SQLite:

```sh
sqlite3 "$DB" "
SELECT COUNT(*) AS remaining_target_threads
FROM projection_threads
WHERE project_id = '$PROJECT_ID';

PRAGMA integrity_check;
"
```

Expected completed-operation results:

```text
0
ok
```

Audit orphan references across the affected tables. Every result was `0` after the completed cleanup:

```sql
SELECT 'projection_thread_messages' AS table_name, COUNT(*) AS orphan_count
FROM projection_thread_messages WHERE thread_id NOT IN (SELECT thread_id FROM projection_threads)
UNION ALL SELECT 'projection_thread_activities', COUNT(*)
FROM projection_thread_activities WHERE thread_id NOT IN (SELECT thread_id FROM projection_threads)
UNION ALL SELECT 'projection_turns', COUNT(*)
FROM projection_turns WHERE thread_id NOT IN (SELECT thread_id FROM projection_threads)
UNION ALL SELECT 'projection_thread_sessions', COUNT(*)
FROM projection_thread_sessions WHERE thread_id NOT IN (SELECT thread_id FROM projection_threads)
UNION ALL SELECT 'projection_thread_attachment_refs', COUNT(*)
FROM projection_thread_attachment_refs WHERE thread_id NOT IN (SELECT thread_id FROM projection_threads)
UNION ALL SELECT 'provider_session_runtime', COUNT(*)
FROM provider_session_runtime WHERE thread_id NOT IN (SELECT thread_id FROM projection_threads)
UNION ALL SELECT 'provider_turn_liveness', COUNT(*)
FROM provider_turn_liveness WHERE thread_id NOT IN (SELECT thread_id FROM projection_threads)
UNION ALL SELECT 'worktree_runtime_leases', COUNT(*)
FROM worktree_runtime_leases WHERE thread_id NOT IN (SELECT thread_id FROM projection_threads)
UNION ALL SELECT 'thread_activity_leases', COUNT(*)
FROM thread_activity_leases WHERE thread_id NOT IN (SELECT thread_id FROM projection_threads)
UNION ALL SELECT 'orchestration_thread_identity', COUNT(*)
FROM orchestration_thread_identity WHERE thread_id NOT IN (SELECT thread_id FROM projection_threads);
```

Finally, run the attachment audit block again with the unlink loop still commented. It must report `orphan files: 0` before considering the recovery complete.
