import { ThreadId } from "@bigbud/contracts";
import { Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

/** Resource inventory queries; no deletion or native session mutation. */
export function makeEntityPurgeResourceSql(sql: SqlClient.SqlClient) {
  const ThreadInput = Schema.Struct({ threadId: ThreadId });
  const readThreadAssets = SqlSchema.findAll({
    Request: ThreadInput,
    Result: Schema.Struct({
      activityKind: Schema.NullOr(Schema.String),
      activityPayloadJson: Schema.NullOr(Schema.String),
      attachmentsJson: Schema.NullOr(Schema.String),
      worktreePath: Schema.NullOr(Schema.String),
      workspaceRoot: Schema.NullOr(Schema.String),
    }),
    execute: ({ threadId }) => sql`
      SELECT NULL AS "activityKind", NULL AS "activityPayloadJson", messages.attachments_json AS "attachmentsJson",
        threads.worktree_path AS "worktreePath", projects.workspace_root AS "workspaceRoot"
      FROM projection_threads AS threads
      LEFT JOIN projection_projects AS projects ON projects.project_id = threads.project_id
      LEFT JOIN projection_thread_messages AS messages ON messages.thread_id = threads.thread_id
      WHERE threads.thread_id = ${threadId}
      UNION ALL SELECT NULL, NULL, messages.attachments_json, NULL, NULL
      FROM projection_thread_messages AS messages WHERE messages.thread_id = ${threadId} AND messages.attachments_json IS NOT NULL
      UNION ALL SELECT activities.kind, activities.payload_json, NULL, NULL, NULL
      FROM projection_thread_activities AS activities WHERE activities.thread_id = ${threadId}
    `,
  });
  const attachmentIsShared = SqlSchema.findOne({
    Request: Schema.Struct({ threadId: ThreadId, attachmentId: Schema.String }),
    Result: Schema.Struct({ shared: Schema.Number }),
    execute: ({ threadId, attachmentId }) => sql`SELECT EXISTS (
      SELECT 1 FROM projection_thread_attachment_refs WHERE thread_id <> ${threadId} AND attachment_id IN (${attachmentId}, '')
    ) AS shared`,
  });
  const listOtherThreadWorktrees = SqlSchema.findAll({
    Request: ThreadInput,
    Result: Schema.Struct({ threadId: ThreadId, worktreePath: Schema.String }),
    execute: ({ threadId }) => sql`SELECT thread_id AS "threadId", worktree_path AS "worktreePath"
      FROM projection_threads WHERE thread_id <> ${threadId} AND worktree_path IS NOT NULL`,
  });
  const listKnownThreadIds = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ threadId: Schema.String }),
    execute: () => sql`SELECT thread_id AS "threadId" FROM projection_threads
      UNION SELECT thread_id FROM orchestration_thread_identity
      UNION SELECT entity_id FROM orchestration_deletion_markers WHERE entity_kind = 'thread'`,
  });
  const listIncompleteThreadManifests = SqlSchema.findAll({
    Request: ThreadInput,
    Result: Schema.Struct({
      entityId: Schema.String,
      jobId: Schema.String,
      resourceManifestJson: Schema.String,
    }),
    execute: ({
      threadId,
    }) => sql`SELECT job_id AS "jobId", entity_id AS "entityId", resource_manifest_json AS "resourceManifestJson"
      FROM purge_jobs WHERE entity_kind = 'thread' AND entity_id <> ${threadId} AND status <> 'completed'`,
  });
  const listLiveWorktreeIdentities = SqlSchema.findAll({
    Request: ThreadInput,
    Result: Schema.Struct({
      canonicalPath: Schema.String,
      device: Schema.Number,
      inode: Schema.Number,
    }),
    execute: () =>
      sql`SELECT canonical_path AS "canonicalPath", device, inode FROM worktree_runtime_leases`,
  });
  return {
    readThreadAssets,
    attachmentIsShared,
    listOtherThreadWorktrees,
    listKnownThreadIds,
    listIncompleteThreadManifests,
    listLiveWorktreeIdentities,
  };
}
