import { CommandId, EventId, ProjectId, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationEventStore identity", (it) => {
  it.effect("appends thread.created before any projection thread row exists", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();
      const threadId = ThreadId.makeUnsafe("thread-created-before-projection");
      const projectId = ProjectId.makeUnsafe("project-created-before-projection");

      const appended = yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-created-before-projection"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-created-before-projection"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId,
          projectId,
          title: "Created before projection",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      assert.equal(appended.type, "thread.created");
      assert.deepEqual(
        yield* sql<{ readonly threadId: string }>`
          SELECT thread_id AS "threadId" FROM orchestration_thread_identity
          WHERE thread_id = ${threadId}
        `,
        [{ threadId }],
      );
      assert.deepEqual(
        yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM projection_threads WHERE thread_id = ${threadId}
        `,
        [{ count: 0 }],
      );
    }),
  );
});
