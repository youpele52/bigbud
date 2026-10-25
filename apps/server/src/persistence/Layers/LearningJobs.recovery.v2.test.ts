import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadId, TurnId } from "@bigbud/contracts";
import { LearningJobRepository } from "../Services/LearningJobs.ts";
import { LearningJobRepositoryLive } from "./LearningJobs.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { insertProjectionThreadParent } from "./ProjectionThread.test.helpers.ts";

const repositoryLayer = LearningJobRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.layer(repositoryLayer)("V2 restart cleanup ownership", (it) => {
  for (const state of ["reviewing", "failed", "completed"] as const) {
    it.effect(`restart ${state} never uses lease age as native cleanup proof`, () =>
      Effect.gen(function* () {
        const jobs = yield* LearningJobRepository;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.makeUnsafe(`v2-recovery-${state}`);
        const jobId = `v2-recovery-${state}`;
        yield* insertProjectionThreadParent({ sql, threadId });
        yield* jobs.createIfAbsent({
          jobId,
          threadId,
          turnId: TurnId.makeUnsafe(jobId),
          provider: "opencodeV2",
          model: "synthetic",
          modelSelection: {
            provider: "opencodeV2",
            subProviderID: "synthetic",
            model: "synthetic",
          },
          state,
          attemptCount: 1,
          memoryUserMessageCount: 15,
          createdAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z",
        });
        assert.isTrue(yield* jobs.acquireLease({ jobId, threadId }));
        const recovered = yield* jobs.recoverInterrupted({ now: "2099-01-01T00:00:00.000Z" });
        const leases =
          yield* sql`SELECT lease_id FROM thread_activity_leases WHERE thread_id = ${threadId}`;
        if (state === "completed") assert.equal(leases.length, 0);
        else {
          assert.equal(leases.length, 1);
          assert.isTrue(yield* jobs.hasPending({ threadId }));
          assert.isFalse(yield* jobs.acquireLease({ jobId: "another-job", threadId }));
          assert.equal(yield* jobs.claim({ jobId, now: "2099-01-01T00:00:00.000Z" }), null);
        }
        if (state === "reviewing") {
          assert.equal(recovered.find((job) => job.jobId === jobId)?.cleanupUnconfirmed, true);
          assert.deepEqual(
            yield* sql`SELECT state, outcome FROM learning_jobs WHERE job_id = ${jobId}`,
            [{ state: "failed", outcome: "cleanup-unconfirmed" }],
          );
        }
        yield* jobs.recoverInterrupted({ now: "2099-01-02T00:00:00.000Z" });
        assert.equal(
          (yield* sql`SELECT lease_id FROM thread_activity_leases WHERE thread_id = ${threadId}`)
            .length,
          state === "completed" ? 0 : 1,
        );
      }),
    );
  }
});
