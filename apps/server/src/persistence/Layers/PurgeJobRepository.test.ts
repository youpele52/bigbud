import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { PurgeJobRepository } from "../Services/PurgeJobRepository.ts";
import { PurgeJobRepositoryLive } from "./PurgeJobRepository.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const repositoryLayer = PurgeJobRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.layer(repositoryLayer)("PurgeJobRepository", (it) => {
  it.effect("reuses an incomplete job for the same entity", () =>
    Effect.gen(function* () {
      const repository = yield* PurgeJobRepository;
      const createdAt = "2026-07-30T00:00:00.000Z";
      const first = yield* repository.createOrGet({
        jobId: "purge-1",
        entityKind: "thread",
        entityId: "thread-1",
        resourceManifest: [{ kind: "attachment", relativePath: "thread-1-file.png" }],
        createdAt,
      });
      const repeated = yield* repository.createOrGet({
        jobId: "purge-2",
        entityKind: "thread",
        entityId: "thread-1",
        resourceManifest: [],
        createdAt,
      });

      assert.equal(first.jobId, "purge-1");
      assert.equal(repeated.jobId, "purge-1");
      assert.deepStrictEqual(first.resourceManifest, [
        { kind: "attachment", relativePath: "thread-1-file.png" },
      ]);
      assert.lengthOf(yield* repository.listIncomplete(10), 1);
    }),
  );

  it.effect("persists phase progress and permits a later completed replacement", () =>
    Effect.gen(function* () {
      const repository = yield* PurgeJobRepository;
      const entity = { entityKind: "project" as const, entityId: "project-1" };
      const first = yield* repository.createOrGet({
        jobId: "purge-project-1",
        ...entity,
        resourceManifest: [],
        createdAt: "2026-07-30T00:00:00.000Z",
      });

      yield* repository.update({
        jobId: first.jobId,
        phase: "database",
        status: "running",
        lastError: null,
        updatedAt: "2026-07-30T00:00:01.000Z",
      });
      const resumed = yield* repository.findIncomplete(entity);
      assert.isTrue(Option.isSome(resumed));
      if (Option.isSome(resumed)) {
        assert.equal(resumed.value.phase, "database");
        assert.equal(resumed.value.attemptCount, 1);
      }

      yield* repository.complete({
        jobId: first.jobId,
        completedAt: "2026-07-30T00:00:02.000Z",
      });
      assert.isTrue(Option.isNone(yield* repository.findIncomplete(entity)));

      const replacement = yield* repository.createOrGet({
        jobId: "purge-project-2",
        ...entity,
        resourceManifest: [],
        createdAt: "2026-07-30T00:00:03.000Z",
      });
      assert.equal(replacement.jobId, "purge-project-2");
    }),
  );

  it.effect("transitions a job only from its expected phase", () =>
    Effect.gen(function* () {
      const repository = yield* PurgeJobRepository;
      const job = yield* repository.createOrGet({
        jobId: "purge-transition",
        entityKind: "thread",
        entityId: "thread-transition",
        resourceManifest: [],
        createdAt: "2026-07-30T00:00:00.000Z",
      });
      assert.isTrue(
        yield* repository.transition({
          jobId: job.jobId,
          expectedPhase: "awaiting-finalization",
          nextPhase: "baseline",
          updatedAt: "2026-07-30T00:00:01.000Z",
        }),
      );
      assert.isFalse(
        yield* repository.transition({
          jobId: job.jobId,
          expectedPhase: "awaiting-finalization",
          nextPhase: "baseline",
          updatedAt: "2026-07-30T00:00:02.000Z",
        }),
      );
    }),
  );
});
