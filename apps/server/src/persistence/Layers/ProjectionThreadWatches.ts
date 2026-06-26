import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ListActiveThreadWatchesByWatchedThreadInput,
  ListActiveThreadWatchesByWatcherAndMessageInput,
  ProjectionThreadWatch,
  ProjectionThreadWatchRepository,
  type ProjectionThreadWatchRepositoryShape,
} from "../Services/ProjectionThreadWatches.ts";

const makeProjectionThreadWatchRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listActiveByWatchedThread = SqlSchema.findAll({
    Request: ListActiveThreadWatchesByWatchedThreadInput,
    Result: ProjectionThreadWatch,
    execute: ({ watchedThreadId }) =>
      sql`
        SELECT
          watch_id AS "watchId",
          watcher_thread_id AS "watcherThreadId",
          watched_thread_id AS "watchedThreadId",
          watched_thread_title AS "watchedThreadTitle",
          source_message_id AS "sourceMessageId",
          status,
          created_at AS "createdAt",
          triggered_at AS "triggeredAt"
        FROM projection_thread_watches
        WHERE watched_thread_id = ${watchedThreadId}
          AND status = 'active'
      `,
  });

  const listActiveByWatcherAndMessage = SqlSchema.findAll({
    Request: ListActiveThreadWatchesByWatcherAndMessageInput,
    Result: ProjectionThreadWatch,
    execute: ({ watcherThreadId, sourceMessageId }) =>
      sql`
        SELECT
          watch_id AS "watchId",
          watcher_thread_id AS "watcherThreadId",
          watched_thread_id AS "watchedThreadId",
          watched_thread_title AS "watchedThreadTitle",
          source_message_id AS "sourceMessageId",
          status,
          created_at AS "createdAt",
          triggered_at AS "triggeredAt"
        FROM projection_thread_watches
        WHERE watcher_thread_id = ${watcherThreadId}
          AND source_message_id = ${sourceMessageId}
          AND status = 'active'
      `,
  });

  const listActiveByWatcher = SqlSchema.findAll({
    Request: Schema.Struct({ watcherThreadId: Schema.String }),
    Result: ProjectionThreadWatch,
    execute: ({ watcherThreadId }) =>
      sql`
        SELECT
          watch_id AS "watchId",
          watcher_thread_id AS "watcherThreadId",
          watched_thread_id AS "watchedThreadId",
          watched_thread_title AS "watchedThreadTitle",
          source_message_id AS "sourceMessageId",
          status,
          created_at AS "createdAt",
          triggered_at AS "triggeredAt"
        FROM projection_thread_watches
        WHERE watcher_thread_id = ${watcherThreadId}
          AND status = 'active'
      `,
  });

  const listAllActive = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadWatch,
    execute: () =>
      sql`
        SELECT
          watch_id AS "watchId",
          watcher_thread_id AS "watcherThreadId",
          watched_thread_id AS "watchedThreadId",
          watched_thread_title AS "watchedThreadTitle",
          source_message_id AS "sourceMessageId",
          status,
          created_at AS "createdAt",
          triggered_at AS "triggeredAt"
        FROM projection_thread_watches
        WHERE status = 'active'
      `,
  });

  const replaceActiveWatchesForMessage: ProjectionThreadWatchRepositoryShape["replaceActiveWatchesForMessage"] =
    Effect.fn("ProjectionThreadWatchRepository.replaceActiveWatchesForMessage")(function* (input) {
      yield* sql`
        UPDATE projection_thread_watches
        SET status = 'cancelled'
        WHERE watcher_thread_id = ${input.watcherThreadId}
          AND source_message_id = ${input.sourceMessageId}
          AND status = 'active'
      `.pipe(Effect.mapError(toPersistenceSqlError("replaceActiveWatchesForMessage:cancel")));

      if (input.watches.length === 0) {
        return;
      }

      for (const watch of input.watches) {
        yield* sql`
          INSERT INTO projection_thread_watches (
            watch_id,
            watcher_thread_id,
            watched_thread_id,
            watched_thread_title,
            source_message_id,
            status,
            created_at,
            triggered_at
          )
          VALUES (
            ${crypto.randomUUID()},
            ${input.watcherThreadId},
            ${watch.watchedThreadId},
            ${watch.watchedThreadTitle},
            ${input.sourceMessageId},
            'active',
            ${input.createdAt},
            NULL
          )
        `.pipe(Effect.mapError(toPersistenceSqlError("replaceActiveWatchesForMessage:insert")));
      }
    });

  const markGroupTriggered: ProjectionThreadWatchRepositoryShape["markGroupTriggered"] = Effect.fn(
    "ProjectionThreadWatchRepository.markGroupTriggered",
  )(function* (input) {
    const rows = yield* sql`
      UPDATE projection_thread_watches
      SET status = 'triggered', triggered_at = ${input.triggeredAt}
      WHERE watcher_thread_id = ${input.watcherThreadId}
        AND source_message_id = ${input.sourceMessageId}
        AND status = 'active'
      RETURNING watch_id AS "watchId"
    `.pipe(Effect.mapError(toPersistenceSqlError("markGroupTriggered")));
    return rows.length > 0;
  });

  const cancelActiveForWatcher: ProjectionThreadWatchRepositoryShape["cancelActiveForWatcher"] =
    Effect.fn("ProjectionThreadWatchRepository.cancelActiveForWatcher")(function* (input) {
      yield* sql`
        UPDATE projection_thread_watches
        SET status = 'cancelled'
        WHERE watcher_thread_id = ${input.watcherThreadId}
          AND status = 'active'
      `.pipe(Effect.mapError(toPersistenceSqlError("cancelActiveForWatcher")));
    });

  return {
    replaceActiveWatchesForMessage,
    listActiveByWatchedThread: (input) =>
      listActiveByWatchedThread(input).pipe(
        Effect.mapError(toPersistenceSqlError("listActiveByWatchedThread")),
      ),
    listActiveByWatcherAndMessage: (input) =>
      listActiveByWatcherAndMessage(input).pipe(
        Effect.mapError(toPersistenceSqlError("listActiveByWatcherAndMessage")),
      ),
    listActiveByWatcher: (watcherThreadId) =>
      listActiveByWatcher({ watcherThreadId }).pipe(
        Effect.mapError(toPersistenceSqlError("listActiveByWatcher")),
      ),
    markGroupTriggered,
    cancelActiveForWatcher,
    listAllActive: () =>
      listAllActive(undefined).pipe(Effect.mapError(toPersistenceSqlError("listAllActive"))),
  } satisfies ProjectionThreadWatchRepositoryShape;
});

export const ProjectionThreadWatchRepositoryLive = Layer.effect(
  ProjectionThreadWatchRepository,
  makeProjectionThreadWatchRepository,
);
