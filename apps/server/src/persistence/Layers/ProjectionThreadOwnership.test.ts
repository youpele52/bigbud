import { EventId, MessageId, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepository } from "../Services/ProjectionThreadMessages.ts";
import { ProjectionThreadSessionRepository } from "../Services/ProjectionThreadSessions.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "./ProjectionThreadMessages.ts";
import { ProjectionThreadSessionRepositoryLive } from "./ProjectionThreadSessions.ts";
import { insertProjectionThreadParent } from "./ProjectionThread.test.helpers.ts";

const layer = Layer.mergeAll(
  ProjectionThreadActivityRepositoryLive,
  ProjectionThreadMessageRepositoryLive,
  ProjectionThreadSessionRepositoryLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.layer(layer)("projection thread ownership", (it) => {
  it.effect("requires a projected thread before writing first-group children", () =>
    Effect.gen(function* () {
      const activities = yield* ProjectionThreadActivityRepository;
      const messages = yield* ProjectionThreadMessageRepository;
      const sessions = yield* ProjectionThreadSessionRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("owned-thread");
      const now = "2026-08-18T00:00:00.000Z";
      const message = messages.upsert({
        messageId: MessageId.makeUnsafe("owned-message"),
        threadId,
        turnId: null,
        role: "user",
        text: "hello",
        isStreaming: false,
        createdAt: now,
        updatedAt: now,
      });
      const activity = activities.upsert({
        activityId: EventId.makeUnsafe("owned-activity"),
        threadId,
        turnId: null,
        tone: "info",
        kind: "test",
        summary: "test",
        payload: {},
        createdAt: now,
      });
      const session = sessions.upsert({
        threadId,
        status: "stopped",
        providerName: null,
        runtimeMode: "full-access",
        activeTurnId: null,
        reason: null,
        lastError: null,
        updatedAt: now,
      });
      const writeChildren = Effect.all([message, activity, session], {
        concurrency: 1,
        discard: true,
      });

      for (const child of [message, activity, session]) {
        assert.equal((yield* Effect.exit(child))._tag, "Failure");
      }
      yield* insertProjectionThreadParent({ sql, threadId, createdAt: now });
      yield* writeChildren;
      const counts = yield* sql<{ readonly count: number }>`
        SELECT
          (SELECT COUNT(*) FROM projection_thread_messages WHERE thread_id = ${threadId}) +
          (SELECT COUNT(*) FROM projection_thread_activities WHERE thread_id = ${threadId}) +
          (SELECT COUNT(*) FROM projection_thread_sessions WHERE thread_id = ${threadId}) AS count
      `;
      assert.deepEqual(counts, [{ count: 3 }]);
    }),
  );
});
