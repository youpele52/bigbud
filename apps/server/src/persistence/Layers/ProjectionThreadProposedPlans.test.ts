import { OrchestrationProposedPlanId, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadProposedPlanRepository } from "../Services/ProjectionThreadProposedPlans.ts";
import { insertProjectionThreadParent } from "./ProjectionThread.test.helpers.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "./ProjectionThreadProposedPlans.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadProposedPlanRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const plan = {
  planId: OrchestrationProposedPlanId.makeUnsafe("plan-1"),
  threadId: ThreadId.makeUnsafe("thread-1"),
  turnId: null,
  planMarkdown: "# Plan",
  implementedAt: null,
  implementationThreadId: null,
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
};

layer("ProjectionThreadProposedPlanRepository", (it) => {
  it.effect("requires a projected thread before writing a plan", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadProposedPlanRepository;

      assert.equal((yield* Effect.exit(repository.upsert(plan)))._tag, "Failure");
    }),
  );

  it.effect("cascades plans when their projected thread is deleted", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadProposedPlanRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* insertProjectionThreadParent({ sql, threadId: plan.threadId });
      yield* repository.upsert(plan);

      yield* sql`DELETE FROM projection_threads WHERE thread_id = ${plan.threadId}`;

      assert.deepEqual(yield* repository.listByThreadId({ threadId: plan.threadId }), []);
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      assert.deepEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
    }),
  );
});
