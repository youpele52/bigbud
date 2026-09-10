import * as TestClock from "effect/testing/TestClock";
import { CommandId, EventId, ProjectId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { BaseTestLayer } from "./ProjectionPipeline.test.helpers.ts";

const projectCreated = (index: number) => ({
  type: "project.created" as const,
  eventId: EventId.makeUnsafe(`mobile-publication-event-${index}`),
  aggregateKind: "project" as const,
  aggregateId: ProjectId.makeUnsafe(`mobile-publication-project-${index}`),
  occurredAt: `2026-09-10T00:00:0${index}.000Z`,
  commandId: CommandId.makeUnsafe(`mobile-publication-command-${index}`),
  causationEventId: null,
  correlationId: null,
  metadata: {},
  payload: {
    projectId: ProjectId.makeUnsafe(`mobile-publication-project-${index}`),
    title: `Publication ${index}`,
    workspaceRoot: `/tmp/mobile-publication-${index}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: `2026-09-10T00:00:0${index}.000Z`,
    updatedAt: `2026-09-10T00:00:0${index}.000Z`,
  },
});

it.layer(OrchestrationProjectionSnapshotQueryLive.pipe(Layer.provideMerge(BaseTestLayer)))(
  "mobile projection publication",
  (it) => {
    it.effect("proves outer commit, rollback, and restart repair with actual projectors", () =>
      Effect.gen(function* () {
        const events = yield* OrchestrationEventStore;
        const pipeline = yield* OrchestrationProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        const query = yield* ProjectionSnapshotQuery;

        yield* events.append(projectCreated(1));
        yield* pipeline.bootstrap;

        const written = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let readerFinished = false;
        const writer = yield* Effect.forkScoped(
          sql.withTransaction(
            Effect.gen(function* () {
              const next = yield* events.append(projectCreated(2));
              yield* pipeline.projectEvent(next);
              yield* Deferred.succeed(written, undefined);
              yield* Deferred.await(release);
            }),
          ),
        );
        yield* Deferred.await(written);

        const reader = yield* Effect.forkScoped(
          query.getMobileRecoveryBaseline!(null).pipe(
            Effect.tap(() => Effect.sync(() => (readerFinished = true))),
          ),
        );
        yield* TestClock.adjust("20 millis");
        assert.equal(readerFinished, false);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(writer);

        const baseline = yield* Fiber.join(reader);
        assert.equal(baseline.snapshotSequence, 2);
        assert.equal(
          baseline.snapshot.projects.some(
            (project) => project.id === "mobile-publication-project-2",
          ),
          true,
        );

        const committedCursors = yield* sql<{ readonly sequence: number }>`
        SELECT DISTINCT last_applied_sequence AS sequence FROM projection_state
      `;
        assert.deepEqual(committedCursors, [{ sequence: 2 }]);

        const rolledBack = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const next = yield* events.append(projectCreated(3));
              yield* pipeline.projectEvent(next);
              return yield* Effect.fail(new Error("test rollback"));
            }),
          )
          .pipe(Effect.result);
        assert.equal(rolledBack._tag, "Failure");
        const afterRollback = yield* sql<{ readonly latest: number; readonly projects: number }>`
        SELECT
          (SELECT MAX(sequence) FROM orchestration_events) AS latest,
          (SELECT COUNT(*) FROM projection_projects WHERE project_id LIKE 'mobile-publication-project-%') AS projects
      `;
        assert.deepEqual(afterRollback, [{ latest: 2, projects: 2 }]);
        const rolledBackBaseline = yield* query.getMobileRecoveryBaseline!(null);
        assert.equal(rolledBackBaseline.snapshotSequence, 2);
        assert.equal(
          rolledBackBaseline.snapshot.projects.some(
            (project) => project.id === "mobile-publication-project-3",
          ),
          false,
        );

        yield* sql`DELETE FROM projection_state WHERE projector = 'projection.projects'`;
        const incomplete = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_state
      `;
        assert.equal(incomplete[0]?.count, 10);
        yield* pipeline.bootstrap;
        const repaired = yield* sql<{ readonly sequence: number }>`
        SELECT last_applied_sequence AS sequence
        FROM projection_state WHERE projector = 'projection.projects'
      `;
        assert.deepEqual(repaired, [{ sequence: 2 }]);
      }),
    );
  },
);
