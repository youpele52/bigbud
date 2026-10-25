import { EventId, ThreadId, type OrchestrationThreadActivity } from "@bigbud/contracts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

/** Resume bounded metadata state only; claimed stages are consumed rather than externally replayed. */
export const makeTitleStageRecovery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const query = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ threadId: ThreadId }),
    execute: (after) => sql`
      SELECT activity.thread_id AS "threadId" FROM projection_thread_activities activity
      JOIN projection_threads thread ON thread.thread_id = activity.thread_id
      WHERE (activity.kind = 'text-generation.title-stage'
          OR (activity.kind = 'text-generation.deferred' AND json_extract(activity.payload_json, '$.operation') = 'title'))
        AND activity.thread_id > ${after}
        AND thread.deleted_at IS NULL AND thread.deleting_at IS NULL AND thread.archived_at IS NULL
      GROUP BY activity.thread_id
      HAVING SUM(CASE WHEN json_extract(activity.payload_json, '$.state') IN ('completed','cancelled','unchanged','uncertain') THEN 1 ELSE 0 END) = 0
        AND NOT EXISTS (SELECT 1 FROM projection_thread_activities final
          WHERE final.thread_id = activity.thread_id AND json_extract(final.payload_json, '$.operation') = 'title'
            AND (final.kind IN ('text-generation.completed','text-generation.uncertain') OR
              (final.kind = 'text-generation.failed' AND json_extract(final.payload_json, '$.finalFailure') = 1)))
      ORDER BY activity.thread_id ASC LIMIT 100`,
  });
  return <E, R>(
    process: (input: {
      payload: { threadId: ThreadId; activity: OrchestrationThreadActivity };
    }) => Effect.Effect<void, E, R>,
  ) =>
    Effect.gen(function* () {
      let after = "";
      while (true) {
        const rows = yield* query(after);
        for (const row of rows) {
          // Scheduling input only: never appended as a fake provider/tool event.
          yield* process({
            payload: {
              threadId: row.threadId,
              activity: {
                id: EventId.makeUnsafe(`title-recovery:${row.threadId}`),
                kind: "text-generation.title-recovery",
                tone: "info",
                summary: "Resume pending title stages",
                payload: {},
                turnId: null,
                createdAt: "1970-01-01T00:00:00.000Z",
              },
            },
          });
        }
        const last = rows.at(-1);
        if (!last || rows.length < 100) break;
        after = last.threadId;
      }
    });
});
