import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
        resourceManifest: [
          {
            kind: "attachment",
            relativePath: "thread-1-file.png",
            identity: null,
            quarantineName: null,
            action: "delete",
          },
        ],
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
        {
          kind: "attachment",
          relativePath: "thread-1-file.png",
          identity: null,
          quarantineName: null,
          action: "delete",
        },
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
      yield* repository.claimResources({
        jobId: first.jobId,
        entityKind: first.entityKind,
        entityId: first.entityId,
        resourceManifest: first.resourceManifest,
        claimedAt: "2026-07-30T00:00:00.500Z",
      });

      assert.isFalse(
        yield* repository.update({
          jobId: first.jobId,
          phase: "database",
          status: "running",
          lastError: null,
          updatedAt: "2026-07-30T00:00:01.000Z",
        }),
      );
      assert.isTrue(
        yield* repository.transition({
          jobId: first.jobId,
          expectedPhase: "awaiting-finalization",
          nextPhase: "database",
          updatedAt: "2026-07-30T00:00:01.000Z",
        }),
      );
      assert.isTrue(
        yield* repository.update({
          jobId: first.jobId,
          phase: "database",
          status: "running",
          lastError: null,
          updatedAt: "2026-07-30T00:00:01.500Z",
        }),
      );
      const resumed = yield* repository.findIncomplete(entity);
      assert.isTrue(Option.isSome(resumed));
      if (Option.isSome(resumed)) {
        assert.equal(resumed.value.phase, "database");
        assert.equal(resumed.value.attemptCount, 0);
      }

      assert.isTrue(
        yield* repository.transition({
          jobId: first.jobId,
          expectedPhase: "database",
          nextPhase: "root",
          updatedAt: "2026-07-30T00:00:01.750Z",
        }),
      );
      assert.isTrue(
        yield* repository.complete({
          jobId: first.jobId,
          completedAt: "2026-07-30T00:00:02.000Z",
        }),
      );
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
      yield* repository.claimResources({
        jobId: job.jobId,
        entityKind: job.entityKind,
        entityId: job.entityId,
        resourceManifest: job.resourceManifest,
        claimedAt: "2026-07-30T00:00:00.500Z",
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
  it.effect("decodes but rejects a late pre-063 manifest bind without identity", () =>
    Effect.gen(function* () {
      const repository = yield* PurgeJobRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO purge_jobs (
          job_id, entity_kind, entity_id, phase, status, resource_manifest_json,
          attempt_count, created_at, updated_at
        ) VALUES (
          'legacy-purge', 'thread', 'legacy-thread', 'files', 'failed',
          '[{"kind":"attachment","relativePath":"legacy.png"}]', 1,
          '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z'
        )
      `;
      const job = yield* repository.findIncomplete({
        entityKind: "thread",
        entityId: "legacy-thread",
      });
      assert.isTrue(Option.isSome(job));
      if (Option.isSome(job)) {
        assert.deepEqual(job.value.resourceManifest, [
          {
            kind: "attachment",
            relativePath: "legacy.png",
            identity: null,
            quarantineName: null,
            action: "delete",
          },
        ]);
        assert.isFalse(
          yield* repository.bindManifest({
            jobId: job.value.jobId,
            expectedManifestJson: JSON.stringify(job.value.resourceManifest),
            expectedUpdatedAt: job.value.updatedAt,
            resourceManifest: job.value.resourceManifest,
            updatedAt: "2026-07-30T00:00:01.000Z",
          }),
        );
      }
    }),
  );
  it.effect("fails closed for stale manifest binding and completion", () =>
    Effect.gen(function* () {
      const repository = yield* PurgeJobRepository;
      const job = yield* repository.createOrGet({
        jobId: "purge-stale",
        entityKind: "project",
        entityId: "project-stale",
        resourceManifest: [],
        createdAt: "2026-07-30T00:00:00.000Z",
      });
      assert.isFalse(
        yield* repository.bindManifest({
          jobId: job.jobId,
          expectedManifestJson: "[]",
          expectedUpdatedAt: "2026-07-30T00:00:00.001Z",
          resourceManifest: [],
          updatedAt: "2026-07-30T00:00:01.000Z",
        }),
      );
      assert.isFalse(
        yield* repository.bindManifest({
          jobId: job.jobId,
          expectedManifestJson: '[{"kind":"attachment"}]',
          expectedUpdatedAt: job.updatedAt,
          resourceManifest: [],
          updatedAt: "2026-07-30T00:00:01.000Z",
        }),
      );
      assert.isTrue(
        yield* repository.transition({
          jobId: job.jobId,
          expectedPhase: "awaiting-finalization",
          nextPhase: "database",
          updatedAt: "2026-07-30T00:00:01.000Z",
        }),
      );
      assert.isFalse(
        yield* repository.bindManifest({
          jobId: job.jobId,
          expectedManifestJson: "[]",
          expectedUpdatedAt: "2026-07-30T00:00:01.000Z",
          resourceManifest: [],
          updatedAt: "2026-07-30T00:00:02.000Z",
        }),
      );
      assert.isFalse(
        yield* repository.complete({
          jobId: job.jobId,
          completedAt: "2026-07-30T00:00:02.000Z",
        }),
      );
      assert.isTrue(
        yield* repository.transition({
          jobId: job.jobId,
          expectedPhase: "database",
          nextPhase: "root",
          updatedAt: "2026-07-30T00:00:02.500Z",
        }),
      );
      yield* repository.claimResources({
        jobId: job.jobId,
        entityKind: job.entityKind,
        entityId: job.entityId,
        resourceManifest: job.resourceManifest,
        claimedAt: "2026-07-30T00:00:02.750Z",
      });
      assert.isTrue(
        yield* repository.complete({
          jobId: job.jobId,
          completedAt: "2026-07-30T00:00:03.000Z",
        }),
      );
      assert.isFalse(
        yield* repository.complete({
          jobId: job.jobId,
          completedAt: "2026-07-30T00:00:03.000Z",
        }),
      );
    }),
  );

  it.effect("selects only due jobs with failed jobs first", () =>
    Effect.gen(function* () {
      const repository = yield* PurgeJobRepository;
      for (const [jobId, createdAt] of [
        ["purge-pending-due", "2026-08-04T00:00:00.000Z"],
        ["purge-failed-due", "2026-08-04T00:00:01.000Z"],
        ["purge-failed-later", "2026-08-04T00:00:02.000Z"],
      ] as const) {
        yield* repository.createOrGet({
          jobId,
          entityKind: "thread",
          entityId: jobId,
          resourceManifest: [],
          createdAt,
        });
      }
      assert.isTrue(
        yield* repository.update({
          jobId: "purge-failed-due",
          phase: "awaiting-finalization",
          status: "failed",
          lastError: "retry",
          updatedAt: "2026-08-04T00:01:00.000Z",
        }),
      );
      assert.isTrue(
        yield* repository.update({
          jobId: "purge-failed-later",
          phase: "awaiting-finalization",
          status: "failed",
          lastError: "retry later",
          updatedAt: "2026-08-04T01:00:00.000Z",
        }),
      );

      const due = yield* repository.listIncomplete(10, "2026-08-04T00:30:00.000Z");
      const selected = due.filter(
        (job) => job.jobId.startsWith("purge-failed-") || job.jobId === "purge-pending-due",
      );
      assert.deepEqual(
        selected.map((job) => job.jobId),
        ["purge-failed-due", "purge-pending-due"],
      );
      assert.equal(selected[0]?.attemptCount, 1);
    }),
  );

  it.effect("requires manual recovery after the retry budget is exhausted", () =>
    Effect.gen(function* () {
      const repository = yield* PurgeJobRepository;
      const job = yield* repository.createOrGet({
        jobId: "purge-exhausted-retries",
        entityKind: "thread",
        entityId: "thread-exhausted-retries",
        resourceManifest: [],
        createdAt: "2026-08-04T00:00:00.000Z",
      });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        assert.isTrue(
          yield* repository.update({
            jobId: job.jobId,
            phase: "awaiting-finalization",
            status: "failed",
            lastError: "entity deletion marker is not yet available",
            updatedAt: `2026-08-04T00:0${attempt + 1}:00.000Z`,
          }),
        );
      }

      const stored = yield* repository.findById(job.jobId);
      assert.equal(stored._tag, "Some");
      if (stored._tag === "Some") {
        assert.equal(stored.value.status, "failed");
        assert.equal(stored.value.lastError, "manual_recovery_required");
        assert.equal(stored.value.attemptCount, 5);
      }
      assert.notInclude(
        (yield* repository.listIncomplete(100, "2026-08-05T00:00:00.000Z")).map(
          (candidate) => candidate.jobId,
        ),
        job.jobId,
      );
    }),
  );
});
