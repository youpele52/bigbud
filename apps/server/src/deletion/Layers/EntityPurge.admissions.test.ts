import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadId } from "@bigbud/contracts";
import { ProviderTurnAdmissions } from "../../persistence/Services/ProviderTurnAdmissions.ts";
import { ProviderTurnAdmissionsLive } from "../../persistence/Layers/ProviderTurnAdmissions.ts";
import { PurgeJobRepository } from "../../persistence/Services/PurgeJobRepository.ts";
import { PurgeJobRepositoryLive } from "../../persistence/Layers/PurgeJobRepository.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { admissionFixture } from "../../persistence/Layers/ProviderTurnAdmissions.test.ts";
import { insertProjectionThreadParent } from "../../persistence/Layers/ProjectionThread.test.helpers.ts";
import { ServerConfig } from "../../startup/config.ts";
import { makeEntityPurgeSql } from "./EntityPurge.sql.ts";
import { makeEntityPurgeClaims } from "./EntityPurge.claims.ts";

const layer = Layer.mergeAll(
  ProviderTurnAdmissionsLive,
  PurgeJobRepositoryLive,
  ServerConfig.layerTest(process.cwd(), { prefix: "bigbud-admission-purge-" }),
).pipe(Layer.provideMerge(SqlitePersistenceMemory), Layer.provideMerge(NodeServices.layer));
const now = "2026-09-30T00:00:00.000Z";
it.layer(layer)("explicit purge admission ownership", (it) => {
  for (const first of ["dispatch-intent", "accepted", "purge", "concurrent"] as const)
    it.effect(
      `${first} wins against the real transactional resource claim; losing side cannot destroy or dispatch`,
      () =>
        Effect.gen(function* () {
          const journal = yield* ProviderTurnAdmissions;
          const jobs = yield* PurgeJobRepository;
          const config = yield* ServerConfig;
          const sql = yield* SqlClient.SqlClient;
          const threadId = ThreadId.makeUnsafe(`purge-admission-${first}`);
          yield* insertProjectionThreadParent({ sql, threadId });
          const input = {
            ...admissionFixture(threadId),
            ownerThreadId: threadId,
            binding: { ...admissionFixture(threadId).binding, threadId },
          };
          let row = yield* journal.reserve(input);
          const job = yield* jobs.createOrGet({
            jobId: threadId,
            entityKind: "thread",
            entityId: threadId,
            resourceManifest: [],
            createdAt: now,
          });
          const queries = makeEntityPurgeSql(sql);
          const claims = makeEntityPurgeClaims({
            config,
            sql,
            jobs,
            queries,
            captureResource: () => Effect.die("empty fixture manifest"),
            resourceOperation: (_operation, run) => Effect.promise(run),
          });
          if (first === "concurrent") {
            const outcomes = yield* Effect.all(
              [
                Effect.exit(journal.transition(row, "dispatch-intent", now)),
                Effect.exit(claims.acquireResourceClaims(job)),
              ],
              { concurrency: 2 },
            );
            assert.equal(outcomes.filter((outcome) => outcome._tag === "Success").length, 1);
            const admission = yield* journal.find(input);
            const resourceClaims =
              yield* sql`SELECT entity_id FROM purge_jobs WHERE entity_id = ${threadId} AND manifest_sealed_at IS NOT NULL`;
            assert.equal(
              (admission?.state === "dispatch-intent" ? 1 : 0) + resourceClaims.length,
              1,
            );
          } else if (first === "purge") {
            yield* claims.acquireResourceClaims(job);
            assert.isTrue(
              Exit.isFailure(yield* Effect.exit(journal.transition(row, "dispatch-intent", now))),
            );
            assert.equal((yield* journal.find(input))?.state, "reserved");
            // Legacy/inconsistent persisted activity must still stop the final destructive gate.
            yield* sql`UPDATE provider_turn_admissions SET state = 'accepted' WHERE owner_thread_id = ${threadId}`;
            assert.equal((yield* queries.countThreadRuntimes({ threadId })).count, 1);
            assert.isTrue(
              Exit.isFailure(yield* Effect.exit(queries.deleteThreadDependents({ threadId }))),
            );
            assert.equal(
              (yield* sql`SELECT thread_id FROM projection_threads WHERE thread_id = ${threadId}`)
                .length,
              1,
            );
          } else {
            row = yield* journal.transition(row, "dispatch-intent", now);
            if (first === "accepted") row = yield* journal.transition(row, "accepted", now);
            yield* sql`DELETE FROM provider_session_runtime WHERE thread_id = ${threadId}`;
            yield* sql`DELETE FROM thread_activity_leases WHERE thread_id = ${threadId}`;
            assert.isTrue(Exit.isFailure(yield* Effect.exit(claims.acquireResourceClaims(job))));
            assert.deepEqual(
              yield* sql`SELECT entity_id FROM purge_resource_claims WHERE entity_id = ${threadId}`,
              [],
            );
            assert.isTrue(
              Exit.isFailure(yield* Effect.exit(queries.deleteThreadDependents({ threadId }))),
            );
            assert.equal(
              (yield* sql`SELECT thread_id FROM projection_threads WHERE thread_id = ${threadId}`)
                .length,
              1,
            );
            if (first === "accepted") {
              yield* journal.transition(row, "terminal", now, "retained", "completed");
              yield* claims.acquireResourceClaims(job);
              assert.equal(
                (yield* sql`SELECT entity_id FROM purge_jobs WHERE entity_id = ${threadId} AND manifest_sealed_at IS NOT NULL`)
                  .length,
                1,
              );
              assert.equal((yield* journal.find(input))?.state, "terminal");
              assert.isTrue(Exit.isFailure(yield* Effect.exit(journal.reserve(input))));
            }
          }
        }),
    );
});
