import {
  EventId,
  IsoDateTime,
  ThreadId,
  type OrchestrationThreadActivity,
} from "@bigbud/contracts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import {
  REQUEST_SETTLED_ID_PREFIX,
  TEXT_GENERATION_REQUEST_KIND,
} from "../../git/Layers/InternalTextGeneration.requests.ts";

const Cursor = Schema.Struct({ createdAt: Schema.String, activityId: Schema.String });
const PendingRequest = Schema.Struct({
  threadId: ThreadId,
  activityId: EventId,
  createdAt: IsoDateTime,
  payload: Schema.fromJsonString(Schema.Unknown),
});

/** Recover only unresolved metadata requests, using existing projection rows and primary-key settlement lookups. */
export const makeTextGenerationRequestRecovery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const query = SqlSchema.findAll({
    Request: Cursor,
    Result: PendingRequest,
    execute: (after) => sql`
      SELECT request.thread_id AS "threadId", request.activity_id AS "activityId",
             request.created_at AS "createdAt", request.payload_json AS payload
      FROM projection_thread_activities request
      JOIN projection_threads thread ON thread.thread_id = request.thread_id
      WHERE request.kind = ${TEXT_GENERATION_REQUEST_KIND}
        AND thread.deleted_at IS NULL AND thread.deleting_at IS NULL AND thread.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM projection_thread_activities settled
                        WHERE settled.activity_id = ${REQUEST_SETTLED_ID_PREFIX} || request.activity_id)
        AND (request.created_at > ${after.createdAt}
             OR (request.created_at = ${after.createdAt} AND request.activity_id > ${after.activityId}))
      ORDER BY request.created_at ASC, request.activity_id ASC LIMIT 100
    `,
  });
  return <E, R>(
    process: (input: {
      payload: { threadId: ThreadId; activity: OrchestrationThreadActivity };
    }) => Effect.Effect<void, E, R>,
  ) =>
    Effect.gen(function* () {
      let cursor = { createdAt: "", activityId: "" };
      while (true) {
        const rows = yield* query(cursor).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("could not recover metadata generation requests", { cause }).pipe(
              Effect.as([]),
            ),
          ),
        );
        for (const row of rows) {
          yield* process({
            payload: {
              threadId: row.threadId,
              activity: {
                id: row.activityId,
                kind: TEXT_GENERATION_REQUEST_KIND,
                tone: "info",
                summary: "Recovered metadata generation request",
                payload: row.payload,
                turnId: null,
                createdAt: row.createdAt,
              },
            },
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("could not resume metadata generation request", {
                requestId: row.activityId,
                cause,
              }),
            ),
          );
        }
        const last = rows.at(-1);
        if (!last || rows.length < 100) break;
        cursor = { createdAt: last.createdAt, activityId: last.activityId };
      }
    });
});
