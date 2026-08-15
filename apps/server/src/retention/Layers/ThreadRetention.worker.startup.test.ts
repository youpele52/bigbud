import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ThreadRetentionRepositoryLive } from "../../persistence/Layers/ThreadRetentionRepository.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ThreadRetentionRepository } from "../../persistence/Services/ThreadRetentionRepository.ts";
import { normalThreadRetentionWork, processThreadRetentionWork } from "./ThreadRetention.worker.ts";

const layer = it.layer(
  ThreadRetentionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
const now = () => Date.parse("2026-08-01T00:01:00.000Z");

layer("thread retention worker startup recovery", (it) => {
  it.effect("keeps persisted manual and scheduled work behind startup readiness", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRetentionRepository;
      const sql = yield* SqlClient.SqlClient;
      const maintenanceReadyAt = yield* Ref.make<number | null>(now() + 10 * 60 * 1_000);
      const freshManualRunIds = yield* Ref.make<ReadonlyArray<string>>([]);
      const processed = yield* Ref.make<ReadonlyArray<string>>([]);

      for (const trigger of ["manual", "scheduled"] as const) {
        yield* sql`DELETE FROM thread_retention_runs`;
        yield* repository.createQueuedRun({
          runId: `persisted-${trigger}`,
          trigger,
          policy: "7-days",
          cutoffAt: "2026-07-01T00:00:00.000Z",
          createdAt: "2026-08-01T00:00:00.000Z",
        });
        yield* processThreadRetentionWork({
          work: normalThreadRetentionWork,
          maintenanceReadyAt,
          freshManualRunIds,
          repository,
          purgeJobs: { countIncomplete: () => Effect.succeed(0) },
          purgeBacklogLimit: 100,
          processQueuedRun: (runId) => Ref.update(processed, (runIds) => [...runIds, runId]),
          scheduleFreshManualWake: () => Effect.void,
          cancelWake: () => Effect.void,
          now,
        });
        assert.deepEqual(yield* Ref.get(processed), []);
        assert.equal(
          Option.getOrThrow(yield* repository.getRun(`persisted-${trigger}`)).status,
          "queued",
        );
      }

      yield* sql`DELETE FROM thread_retention_runs`;
      yield* repository.createOrGetActiveRun({
        runId: "persisted-scheduled-active",
        trigger: "scheduled",
        policy: "7-days",
        cutoffAt: "2026-07-01T00:00:00.000Z",
        createdAt: "2026-08-01T00:00:00.000Z",
      });
      yield* repository.createQueuedRun({
        runId: "persisted-manual-priority",
        trigger: "manual",
        policy: "7-days",
        cutoffAt: "2026-07-01T00:00:00.000Z",
        createdAt: "2026-08-01T00:00:01.000Z",
      });
      yield* processThreadRetentionWork({
        work: normalThreadRetentionWork,
        maintenanceReadyAt: yield* Ref.make<number | null>(now() - 1),
        freshManualRunIds,
        repository,
        purgeJobs: { countIncomplete: () => Effect.succeed(0) },
        purgeBacklogLimit: 100,
        processQueuedRun: (runId) => Ref.update(processed, (runIds) => [...runIds, runId]),
        scheduleFreshManualWake: () => Effect.void,
        cancelWake: () => Effect.void,
        now,
      });
      assert.deepEqual(yield* Ref.get(processed), [
        "persisted-scheduled-active",
        "persisted-manual-priority",
      ]);
      assert.equal(
        Option.getOrThrow(yield* repository.getRun("persisted-scheduled-active")).status,
        "deferred",
      );
    }),
  );
});
