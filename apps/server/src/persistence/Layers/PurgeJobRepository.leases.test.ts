import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { PurgeJobRepository } from "../Services/PurgeJobRepository.ts";
import { PurgeJobRepositoryLive } from "./PurgeJobRepository.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = PurgeJobRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.layer(layer)("PurgeJobRepository execution leases", (it) => {
  it.effect("leases across processes and excludes exhausted retries from backlog", () =>
    Effect.gen(function* () {
      const repository = yield* PurgeJobRepository;
      const initialBacklog = yield* repository.countIncomplete();
      const leased = yield* repository.createOrGet({
        jobId: "purge-leased",
        entityKind: "thread",
        entityId: "thread-leased",
        resourceManifest: [],
        createdAt: "2026-08-04T00:00:00.000Z",
      });
      const exhausted = yield* repository.createOrGet({
        jobId: "purge-exhausted",
        entityKind: "thread",
        entityId: "thread-exhausted",
        resourceManifest: [],
        createdAt: "2026-08-04T00:00:00.000Z",
      });
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        assert.isTrue(
          yield* repository.update({
            jobId: exhausted.jobId,
            phase: "awaiting-finalization",
            status: "failed",
            lastError: "permanent",
            updatedAt: `2026-08-04T00:00:0${attempt}.000Z`,
          }),
        );
      }

      assert.equal(yield* repository.countIncomplete(), initialBacklog + 1);
      assert.deepEqual(
        (yield* repository.listIncomplete(10, "2026-08-04T01:00:00.000Z"))
          .map((job) => job.jobId)
          .filter((jobId) => jobId === leased.jobId || jobId === exhausted.jobId),
        [leased.jobId],
      );
      assert.isTrue(
        yield* repository.claimExecution({
          jobId: leased.jobId,
          leaseId: "lease-a",
          claimedAt: "2026-08-04T00:01:00.000Z",
          expiresAt: "2026-08-04T00:02:00.000Z",
        }),
      );
      assert.isFalse(
        yield* repository.claimExecution({
          jobId: leased.jobId,
          leaseId: "lease-b",
          claimedAt: "2026-08-04T00:01:30.000Z",
          expiresAt: "2026-08-04T00:03:00.000Z",
        }),
      );
      assert.isTrue(
        yield* repository.claimExecution({
          jobId: leased.jobId,
          leaseId: "lease-b",
          claimedAt: "2026-08-04T00:02:00.000Z",
          expiresAt: "2026-08-04T00:03:00.000Z",
        }),
      );
      yield* repository.releaseExecution(leased.jobId, "lease-a");
      assert.isFalse(
        yield* repository.claimExecution({
          jobId: leased.jobId,
          leaseId: "lease-c",
          claimedAt: "2026-08-04T00:02:30.000Z",
          expiresAt: "2026-08-04T00:04:00.000Z",
        }),
      );
    }),
  );
});
