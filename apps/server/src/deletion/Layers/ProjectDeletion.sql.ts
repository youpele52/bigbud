import { ProjectId, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export function makeProjectDeletionSql(sql: SqlClient.SqlClient) {
  const rejectSharedScheduleTargetsForThreads = ({
    threadIds,
  }: {
    readonly threadIds: ReadonlyArray<ThreadId>;
  }) =>
    sql<{ readonly automationId: string }>`
      SELECT automation_id AS "automationId"
      FROM automation_schedules
      JOIN projection_threads ON projection_threads.thread_id = automation_schedules.target_thread_id
      WHERE automation_schedules.target_thread_id IN (
        SELECT value FROM json_each(${JSON.stringify(threadIds)})
      )
        AND (automation_schedules.project_id IS NULL
          OR automation_schedules.project_id <> projection_threads.project_id)
      LIMIT 1
    `.pipe(
      Effect.flatMap((rows) =>
        rows.length === 0
          ? Effect.void
          : Effect.fail(new Error("thread has a schedule owned by another project")),
      ),
    );

  const rejectSharedScheduleTarget = ({ threadId }: { readonly threadId: ThreadId }) =>
    rejectSharedScheduleTargetsForThreads({ threadIds: [threadId] });

  const rejectSharedScheduleTargets = ({ projectId }: { readonly projectId: ProjectId }) =>
    sql<{ readonly automationId: string }>`
      SELECT automation_id AS "automationId"
      FROM automation_schedules
      JOIN projection_threads ON projection_threads.thread_id = automation_schedules.target_thread_id
      WHERE projection_threads.project_id = ${projectId}
        AND (automation_schedules.project_id IS NULL OR automation_schedules.project_id <> ${projectId})
      LIMIT 1
    `.pipe(
      Effect.flatMap((rows) =>
        rows.length === 0
          ? Effect.void
          : Effect.fail(new Error("project thread has a schedule owned by another project")),
      ),
    );

  const deleteProjectOperationalDependents = ({ projectId }: { readonly projectId: ProjectId }) =>
    Effect.uninterruptible(
      sql.withTransaction(
        Effect.all(
          [
            sql`DELETE FROM automation_schedules WHERE project_id = ${projectId}`,
            sql`DELETE FROM projection_notes WHERE project_id = ${projectId}`,
            sql`DELETE FROM remote_agent_restart_requests WHERE project_id = ${projectId}`,
            sql`DELETE FROM orchestration_bootstrap_recipes WHERE project_id = ${projectId}`,
            sql`UPDATE thread_delegations
                SET target_project_id = NULL
                WHERE target_project_id = ${projectId}`,
            sql`UPDATE thread_delegations
                SET created_project_id = NULL
                WHERE created_project_id = ${projectId}`,
          ],
          { concurrency: 1, discard: true },
        ),
      ),
    );

  const deleteProjectDependents = (input: { readonly projectId: ProjectId }) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* rejectSharedScheduleTargets(input);
        yield* deleteProjectOperationalDependents(input);
        yield* sql`
          UPDATE projection_threads SET parent_thread_id = NULL,
            parent_thread_title = NULL, parent_thread_project_id = NULL
          WHERE project_id <> ${input.projectId} AND parent_thread_id IN (
            SELECT thread_id FROM projection_threads WHERE project_id = ${input.projectId}
          )
        `;
        yield* sql`DELETE FROM projection_threads WHERE project_id = ${input.projectId}`;
      }),
    );

  const deleteProvenProjectCanonical = ({ projectId }: { readonly projectId: ProjectId }) =>
    sql.withTransaction(
      Effect.all(
        [
          sql`
            INSERT INTO orchestration_event_gaps (sequence, event_id, created_at)
            SELECT sequence, event_id, ${new Date().toISOString()}
            FROM orchestration_events
            WHERE aggregate_kind = 'project' AND stream_id = ${projectId}
            ON CONFLICT (sequence) DO NOTHING
          `,
          sql`
            DELETE FROM orchestration_command_receipt_claims
            WHERE command_id IN (
              SELECT command_id FROM orchestration_events
              WHERE aggregate_kind = 'project' AND stream_id = ${projectId}
            )
          `,
          sql`
            DELETE FROM orchestration_event_ids
            WHERE sequence IN (
              SELECT sequence FROM orchestration_events
              WHERE aggregate_kind = 'project' AND stream_id = ${projectId}
            )
          `,
          sql`
            DELETE FROM orchestration_stream_state
            WHERE aggregate_kind = 'project' AND stream_id = ${projectId}
          `,
          sql`
            DELETE FROM orchestration_events
            WHERE aggregate_kind = 'project' AND stream_id = ${projectId}
          `,
          sql`
            DELETE FROM orchestration_deletion_markers
            WHERE entity_kind = 'project' AND entity_id = ${projectId}
          `,
        ],
        { concurrency: 1, discard: true },
      ),
    );

  return {
    assertProjectDeletionSafe: rejectSharedScheduleTargets,
    assertThreadDeletionSafe: rejectSharedScheduleTarget,
    assertThreadDeletionSafeForThreads: rejectSharedScheduleTargetsForThreads,
    deleteProjectOperationalDependents,
    deleteProjectDependents,
    deleteProvenProjectCanonical,
  };
}
