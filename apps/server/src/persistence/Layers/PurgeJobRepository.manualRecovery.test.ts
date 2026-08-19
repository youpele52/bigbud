import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PurgeJobRepository } from "../Services/PurgeJobRepository.ts";
import { PurgeJobRepositoryLive } from "./PurgeJobRepository.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = PurgeJobRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.layer(layer)("PurgeJobRepository manual recovery", (it) => {
  it.effect("keeps quarantined manifests readable but out of automatic work", () =>
    Effect.gen(function* () {
      const repository = yield* PurgeJobRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO purge_jobs (
          job_id, entity_kind, entity_id, phase, status, resource_manifest_json,
          last_error, auto_resume_disabled, created_at, updated_at
        ) VALUES (
          'manual-recovery-job', 'thread', 'thread-1', 'files', 'failed',
          '[{"kind":"attachment","relativePath":"attachment.png"}]',
          'manual_recovery_required', 0, 'now', 'now'
        )
      `;

      const entity = { entityKind: "thread" as const, entityId: "thread-1" };
      assert.isTrue(Option.isNone(yield* repository.findIncomplete(entity)));
      assert.deepEqual(yield* repository.listIncomplete(10), []);
      assert.equal(yield* repository.countIncomplete(), 0);
      assert.isFalse(
        yield* repository.claimExecution({
          jobId: "manual-recovery-job",
          leaseId: "lease",
          claimedAt: "2026-08-18T00:00:00.000Z",
          expiresAt: "2026-08-18T01:00:00.000Z",
        }),
      );

      const job = yield* repository.findById("manual-recovery-job");
      assert.isTrue(Option.isSome(job));
      if (Option.isSome(job)) {
        assert.equal(job.value.lastError, "manual_recovery_required");
      }
    }),
  );
});
