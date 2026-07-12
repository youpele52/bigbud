import { ThreadId, TurnId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { LearningJobRepository } from "../Services/LearningJobs.ts";
import { LearningJobRepositoryLive } from "./LearningJobs.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = LearningJobRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.layer(layer)("LearningJobRepository", (it) => {
  it.effect("creates one durable job per thread turn", () =>
    Effect.gen(function* () {
      const repository = yield* LearningJobRepository;
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

  it.effect("ignores skill-only jobs when reading the latest memory review count", () =>
    Effect.gen(function* () {
      const repository = yield* LearningJobRepository;
      const threadId = ThreadId.makeUnsafe("thread-skill-only");
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
