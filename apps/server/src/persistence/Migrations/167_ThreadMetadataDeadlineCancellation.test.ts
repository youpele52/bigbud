import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { runMigrations } from "../Migrations.ts";
import { makeThreadMetadataGenerationRepository } from "../Layers/ThreadMetadataGeneration.ts";
import { installTestProjectionThreadParentTriggers } from "../Layers/Sqlite.testParentThreads.ts";
import { ThreadMetadataGenerationRepository } from "../Services/ThreadMetadataGeneration.ts";
import {
  seedFinalJob,
  seedFinalAttempt,
} from "../Layers/ThreadMetadataGeneration.finalWarnings.test-helpers.ts";

it.effect(
  "migration 167 preserves historical cancellation evidence without inferring safe dispatch history",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 166 });
      yield* installTestProjectionThreadParentTriggers();
      const r = yield* makeThreadMetadataGenerationRepository();
      const job = yield* Effect.gen(function* () {
        const { job } = yield* seedFinalJob("pre-167-cancelled");
        yield* seedFinalAttempt(job.jobId, "cancelled");
        return job;
      }).pipe(Effect.provideService(ThreadMetadataGenerationRepository, r));
      yield* sql`UPDATE thread_metadata_generation_attempts SET dispatched_at = 'retained-dispatch',
      result = 'retained-result', revision = 4 WHERE job_id = ${job.jobId}`;
      yield* runMigrations({ toMigrationInclusive: 167 });
      assert.deepStrictEqual(
        yield* sql`SELECT state, dispatched_at AS dispatched, result, revision,
      cancelled_before_dispatch_at_deadline AS marker FROM thread_metadata_generation_attempts`,
        [
          {
            state: "cancelled",
            dispatched: "retained-dispatch",
            result: "retained-result",
            revision: 4,
            marker: 0,
          },
        ],
      );
      yield* sql`UPDATE thread_metadata_generation_jobs SET state = 'exhausted' WHERE job_id = ${job.jobId}`;
      assert.isFalse(yield* r.enqueueFinalWarning({ jobId: job.jobId, at: job.deadlineAt }));
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 167 }), []);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
