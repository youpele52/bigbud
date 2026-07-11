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
        state: "queued" as const,
        createdAt: "2026-07-11T10:00:00.000Z",
        updatedAt: "2026-07-11T10:00:00.000Z",
      };

      assert.isTrue(yield* repository.createIfAbsent(job));
      assert.isFalse(yield* repository.createIfAbsent(job));
      assert.equal((yield* repository.listQueued()).length, 1);
    }),
  );
});
