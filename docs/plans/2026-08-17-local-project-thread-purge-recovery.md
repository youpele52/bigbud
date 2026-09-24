# Local Project Thread Purge Recovery Record

**Date:** 17 August, 2026
**Status:** Implemented
**Owner:** Administrative recovery

## Summary

This record documents a one-time administrative recovery that directly purged all threads for the local bigbud project at `/Users/youpele/DevWorld/bigbud` (`project_id` `1c4f7525-6e2b-4c23-b079-4052a36d0f4c`) from `~/.bigbud/userdata/state.sqlite`. It is not normal application behavior or a replacement for bigbud's supported thread-retention flow.

## Related Work

- [Automatic thread cleanup](../thread-retention.md) documents the supported retention behavior and backup-only recovery policy.
- [Operational recovery runbook](2026-08-17-local-project-thread-purge-recovery.runbook.md) preserves the read-only audits, destructive SQL, attachment cleanup, and post-operation verification commands for handoff.
- No repository issue, pull request, note, or Kanban card was identified; this documents a completed local administrative operation.

## Problem

The local project's thread history required a targeted destructive reset while retaining the project record itself.

## Goals

- Remove all 862 target threads and their dependent thread data.
- Remove dependent attachment references and attachment files no longer referenced by retained data.
- Retain the project record with zero threads.
- Verify database integrity and relevant orphan references after the operation.

## Non-Goals

- Changing application code, migrations, or normal retention behavior.
- Deleting the project record.
- Providing an undo path for the deletion.

## Current State

- The server derives the production local database as `~/.bigbud/userdata/state.sqlite` and attachment directory as `~/.bigbud/userdata/attachments` in [startup configuration](../../apps/server/src/startup/config.ts#L71-L74).
- Attachment references are stored in `projection_thread_attachment_refs`; [migration 070](../../apps/server/src/persistence/Migrations/070_ThreadAttachmentReferences.ts#L18-L34) creates cleanup triggers for message and activity deletion.
- [Supported thread retention](../thread-retention.md) is destructive and backup-only for recovery; it does not run `VACUUM` because that can require additional disk space.

## Phases

### Phase 1: Direct Administrative Purge

1. Targeted `project_id` `1c4f7525-6e2b-4c23-b079-4052a36d0f4c` in `~/.bigbud/userdata/state.sqlite`.
2. Directly removed 862 project threads, their dependent thread data, and dependent attachment references.
3. Deleted only files in `~/.bigbud/userdata/attachments` that were no longer referenced after the database cleanup.
4. Retained the project record intentionally; it now has zero threads.

### Phase 2: Validate The Completed State

1. Ran `PRAGMA integrity_check`, which returned `ok`.
2. Audited relevant tables for orphan references; the final count was zero.

The following concise SQL illustrates the post-operation checks. It is validation reference only, not a general-purpose deletion script:

```sql
PRAGMA integrity_check;

SELECT COUNT(*) AS remaining_target_threads
FROM projection_threads
WHERE project_id = '1c4f7525-6e2b-4c23-b079-4052a36d0f4c';

SELECT COUNT(*) AS orphan_attachment_refs
FROM projection_thread_attachment_refs AS ref
LEFT JOIN projection_threads AS thread ON thread.thread_id = ref.thread_id
WHERE thread.thread_id IS NULL;
```

## Risks And Decision Gates

- This was an irreversible direct database and filesystem operation. Do not treat it as a supported in-app deletion path.
- Stop bigbud and make a verified, consistent backup of the database and associated state directories before any comparable operation. Restoring selected rows or only attachment files is unsupported and can leave state inconsistent.
- A database backup was attempted before this operation but failed because no disk space was available. The purge proceeded without a backup at the user's direction; consequently, there is no rollback for the removed data.
- Do not run `VACUUM` as part of a space-constrained recovery without first confirming sufficient free space.

## Testing And Validation

- `PRAGMA integrity_check` returned `ok`.
- Final orphan-reference audit across relevant tables returned zero.
- Verified the target project record remains and has zero threads.
- Verified no-longer-referenced attachment files were removed from `~/.bigbud/userdata/attachments`.

## Acceptance Criteria

- All 862 target threads are removed.
- The local project record remains with zero threads.
- Dependent thread data and attachment references are removed.
- Unreferenced attachment files are removed.
- SQLite integrity check returns `ok` and relevant orphan-reference audit returns zero.

## Open Questions

- None.
