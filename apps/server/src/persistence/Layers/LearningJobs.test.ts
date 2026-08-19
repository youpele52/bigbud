import { ThreadId, TurnId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { LearningJobRepository } from "../Services/LearningJobs.ts";
import { LearningJobRepositoryLive } from "./LearningJobs.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { insertProjectionThreadParent } from "./ProjectionThread.test.helpers.ts";

const layer = LearningJobRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.layer(layer)("LearningJobRepository", (it) => {
  it.effect("creates one durable job per thread turn", () =>
    Effect.gen(function* () {
      const repository = yield* LearningJobRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* insertProjectionThreadParent({
        sql,
        threadId: ThreadId.makeUnsafe("thread-learning"),
      });
      const job = {
        jobId: "learning:thread:turn",
        threadId: ThreadId.makeUnsafe("thread-learning"),
        turnId: TurnId.makeUnsafe("turn-learning"),
        provider: "codex" as const,
        model: "gpt-5",
        modelSelection: { provider: "codex" as const, model: "gpt-5" },
        memoryUserMessageCount: 15,
        state: "queued" as const,
        createdAt: "2026-07-11T10:00:00.000Z",
        updatedAt: "2026-07-11T10:00:00.000Z",
      };

      assert.isTrue(yield* repository.createIfAbsent(job));
      assert.isFalse(yield* repository.createIfAbsent(job));
      assert.equal((yield* repository.listQueued()).length, 1);
      assert.equal(
        yield* repository.getLatestMemoryUserMessageCount({ threadId: job.threadId }),
        15,
      );

      assert.isTrue(
        yield* repository.createIfAbsent({
          ...job,
          jobId: "learning:thread:turn-next",
          turnId: TurnId.makeUnsafe("turn-learning-next"),
          memoryUserMessageCount: 30,
        }),
      );
      assert.equal(
        yield* repository.getLatestMemoryUserMessageCount({ threadId: job.threadId }),
        30,
      );
    }),
  );

  it.effect("reads legacy provider jobs so the reactor can mark them for reselection", () =>
    Effect.gen(function* () {
      const repository = yield* LearningJobRepository;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-07-11T10:00:00.000Z";
      yield* insertProjectionThreadParent({
        sql,
        threadId: ThreadId.makeUnsafe("thread-learning-legacy"),
      });
      yield* sql`
        INSERT INTO learning_jobs (
          job_id, thread_id, turn_id, provider, model, model_selection_json,
          memory_user_message_count, state, created_at, updated_at
        ) VALUES (
          ${"learning:legacy"}, ${"thread-learning-legacy"}, ${"turn-learning-legacy"},
          ${"removedProvider"}, ${"legacy-model"},
          ${JSON.stringify({ provider: "removedProvider", model: "legacy-model" })},
          ${null}, ${"queued"}, ${now}, ${now}
        )
      `;

      const jobs = yield* repository.listQueued();
      assert.equal(String(jobs.at(-1)?.provider), "removedProvider");
      assert.deepEqual(jobs.at(-1)?.modelSelection, {
        provider: "removedProvider",
        model: "legacy-model",
      } as unknown as (typeof jobs)[number]["modelSelection"]);
    }),
  );

  it.effect("ignores skill-only jobs when reading the latest memory review count", () =>
    Effect.gen(function* () {
      const repository = yield* LearningJobRepository;
      const threadId = ThreadId.makeUnsafe("thread-skill-only");
      const sql = yield* SqlClient.SqlClient;
      yield* insertProjectionThreadParent({ sql, threadId });
      const job = {
        jobId: "learning:thread:turn-skill",
        threadId,
        turnId: TurnId.makeUnsafe("turn-skill"),
        provider: "codex" as const,
        model: "gpt-5",
        modelSelection: { provider: "codex" as const, model: "gpt-5" },
        memoryUserMessageCount: null,
        state: "queued" as const,
        createdAt: "2026-07-11T10:00:00.000Z",
        updatedAt: "2026-07-11T10:00:00.000Z",
      };

      assert.isTrue(yield* repository.createIfAbsent(job));
      assert.equal(yield* repository.getLatestMemoryUserMessageCount({ threadId }), null);
    }),
  );
});
