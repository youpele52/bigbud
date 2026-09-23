import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { DirectResourceCleanupRepositoryLive } from "../../persistence/Layers/DirectResourceCleanupRepository.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { makeRetentionCleanupReader } from "../../persistence/Layers/ThreadRetentionRepository.cleanup.ts";
import {
  finalizeProjectCanonicalHistory,
  finalizeProjectCanonicalHistoryWithCoverage,
} from "./CanonicalThreadCleanup.ts";
import { prepareProjectCanonicalRows } from "./CanonicalThreadCleanup.project.test-fixtures.ts";
import { recoverCanonicalPruningCandidates } from "./DirectResourceCleanupRecovery.ts";

const layer = it.layer(
  DirectResourceCleanupRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("project canonical checkpoint production paths", (it) => {
  for (const reconcile of [false, true]) {
    it.effect(
      `requires real pruning after ${reconcile ? "reconciliation" : "proof creation"}`,
      () =>
        Effect.gen(function* () {
          const f = yield* prepareProjectCanonicalRows(`producer-${reconcile}`, reconcile);
          assert.deepEqual(
            (yield* f.repository.listCanonicalPruning(10)).filter(
              (candidate) => candidate.operationId === f.operationId,
            ),
            [
              {
                operationId: f.operationId,
                aggregateKind: "project",
                aggregateId: f.projectId,
                deletionSequence: f.deletionSequence,
              },
            ],
          );
          assert.equal(
            yield* f.repository.claimReady({
              leaseId: "too-early",
              claimedAt: f.now,
              expiresAt: "2026-08-30T00:01:00.000Z",
              expectedPlatform: "darwin/arm64",
            }),
            undefined,
          );
          yield* finalizeProjectCanonicalHistoryWithCoverage({
            sql: f.sql,
            projectId: f.projectId,
            recordCheckpoint: f.repository.markCanonicalPruned(f.operationId, f.now, "project"),
          });
          assert.deepEqual(
            (yield* f.repository.listCanonicalPruning(10)).filter(
              (candidate) => candidate.operationId === f.operationId,
            ),
            [],
          );
          assert.equal((yield* f.sql`SELECT 1 FROM orchestration_events`).length, 0);
          assert.equal((yield* f.sql`SELECT 1 FROM orchestration_command_receipts`).length, 0);
          assert.equal(
            (yield* f.repository.claimReady({
              leaseId: "pruned",
              claimedAt: f.now,
              expiresAt: "2026-08-30T00:01:00.000Z",
              expectedPlatform: "darwin/arm64",
            }))?.operationId,
            f.operationId,
          );
        }),
    );
  }

  it.effect("rolls back failed checkpoints and recovers completed filesystem plans", () =>
    Effect.gen(function* () {
      const f = yield* prepareProjectCanonicalRows("retry");
      yield* f.repository.complete(f.operationId, f.now);
      const failed = yield* Effect.exit(
        finalizeProjectCanonicalHistoryWithCoverage({
          sql: f.sql,
          projectId: f.projectId,
          recordCheckpoint: Effect.fail(new Error("checkpoint unavailable")),
        }),
      );
      assert.equal(failed._tag, "Failure");
      assert.equal((yield* f.sql`SELECT 1 FROM orchestration_events`).length, 1);
      assert.equal((yield* f.sql`SELECT 1 FROM orchestration_command_receipts`).length, 1);
      assert.equal(
        (yield* f.repository.listCanonicalPruning(10)).filter(
          (candidate) => candidate.operationId === f.operationId,
        ).length,
        1,
      );
      yield* finalizeProjectCanonicalHistoryWithCoverage({
        sql: f.sql,
        projectId: f.projectId,
        recordCheckpoint: f.repository.markCanonicalPruned(f.operationId, f.now, "project"),
      });
      assert.deepEqual(yield* f.repository.listCanonicalPruning(10), []);
    }),
  );

  it.effect("does not prune without verified replacement coverage", () =>
    Effect.gen(function* () {
      const f = yield* prepareProjectCanonicalRows("coverage-failure");
      const failed = yield* Effect.exit(
        finalizeProjectCanonicalHistory({
          sql: f.sql,
          projectId: f.projectId,
          projectionPipeline: {
            ensureVerifiedBaselineThroughWithoutCompaction: () =>
              Effect.fail(new Error("unverified")),
          } as never,
          recordCheckpoint: f.repository.markCanonicalPruned(f.operationId, f.now, "project"),
        }),
      );
      assert.equal(failed._tag, "Failure");
      assert.equal((yield* f.sql`SELECT 1 FROM orchestration_deletion_markers`).length, 1);
      assert.equal(
        (yield* f.repository.listCanonicalPruning(10)).filter(
          (candidate) => candidate.operationId === f.operationId,
        ).length,
        1,
      );
    }),
  );

  it.effect("recovers canonical history after physical cleanup becomes blocked", () =>
    Effect.gen(function* () {
      const f = yield* prepareProjectCanonicalRows("blocked-prune");
      const failed = yield* Effect.exit(
        finalizeProjectCanonicalHistoryWithCoverage({
          sql: f.sql,
          projectId: f.projectId,
          recordCheckpoint: Effect.fail(new Error("checkpoint unavailable")),
        }),
      );
      assert.equal(failed._tag, "Failure");
      yield* f.sql`UPDATE direct_resource_cleanup_plans SET state = 'blocked'
        WHERE operation_id = ${f.operationId}`;
      assert.equal(
        yield* makeRetentionCleanupReader(f.sql)("project-source-blocked-prune"),
        "pending",
      );
      assert.equal(
        (yield* f.repository.listCanonicalPruning(10)).filter(
          (candidate) => candidate.operationId === f.operationId,
        ).length,
        1,
      );
      yield* finalizeProjectCanonicalHistoryWithCoverage({
        sql: f.sql,
        projectId: f.projectId,
        recordCheckpoint: f.repository.markCanonicalPruned(f.operationId, f.now, "project"),
      });
      assert.equal(
        (yield* f.repository.listCanonicalPruning(10)).filter(
          (candidate) => candidate.operationId === f.operationId,
        ).length,
        0,
      );
      assert.equal(
        yield* makeRetentionCleanupReader(f.sql)("project-source-blocked-prune"),
        "blocked",
      );
    }),
  );

  it.effect("shares replacement verification across a batch of project prunes", () =>
    Effect.gen(function* () {
      const first = yield* prepareProjectCanonicalRows("batch-first");
      const second = yield* prepareProjectCanonicalRows("batch-second");
      const coverage: number[] = [];
      yield* recoverCanonicalPruningCandidates({
        candidates: [first, second],
        requiredSequence: (f) => f.deletionSequence,
        ensureCoverage: (sequence) =>
          Effect.sync(() => {
            coverage.push(sequence);
          }),
        finalizeCandidate: (f) =>
          finalizeProjectCanonicalHistoryWithCoverage({
            sql: f.sql,
            projectId: f.projectId,
            recordCheckpoint: f.repository.markCanonicalPruned(f.operationId, f.now, "project"),
          }),
      });
      assert.deepEqual(coverage, [second.deletionSequence]);
      assert.isFalse(
        (yield* first.repository.listCanonicalPruning(10)).some(
          (candidate) => candidate.operationId === first.operationId,
        ),
      );
    }),
  );
});
