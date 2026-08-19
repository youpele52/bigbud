import { RuntimeTaskId, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadTaskRepository } from "../Services/ProjectionThreadTasks.ts";
import { insertProjectionThreadParent } from "./ProjectionThread.test.helpers.ts";
import { ProjectionThreadTaskRepositoryLive } from "./ProjectionThreadTasks.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadTaskRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const task = {
  id: RuntimeTaskId.makeUnsafe("task-1"),
  status: "inProgress" as const,
  subject: "Durable task",
  source: "observed" as const,
  freshness: {
    sessionEpoch: "epoch-1",
    sourcePriority: 1,
    observedOrdinal: 1,
  },
  createdAt: "2026-07-25T00:00:00.000Z",
  updatedAt: "2026-07-25T00:00:01.000Z",
};

layer("ProjectionThreadTaskRepository", (it) => {
  it.effect("round-trips task metadata and supports replacement/removal", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadTaskRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-1");
      yield* insertProjectionThreadParent({ sql, threadId, createdAt: task.createdAt });
      yield* repository.upsert({ taskId: task.id, threadId, task });
      const loaded = yield* repository.getByTaskId({ taskId: task.id });
      assert.equal(loaded._tag, "Some");
      if (loaded._tag === "Some") {
        assert.deepStrictEqual(loaded.value.task, task);
      }
      const listed = yield* repository.listByThreadId({ threadId });
      assert.equal(listed.length, 1);
      yield* repository.remove({ taskId: task.id });
      assert.equal((yield* repository.listByThreadId({ threadId })).length, 0);
    }),
  );

  it.effect("requires a projected thread before writing a task", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadTaskRepository;
      const threadId = ThreadId.makeUnsafe("missing-thread");

      assert.equal(
        (yield* Effect.exit(repository.upsert({ taskId: task.id, threadId, task })))._tag,
        "Failure",
      );
    }),
  );
});
