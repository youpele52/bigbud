import { CommandId, EventId, ProjectId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import {
  makeProjectionBaselineCoordinator,
  PROJECTION_BASELINE_FAILURE_COOLDOWN_MS,
} from "./ProjectionPipeline.baseline.coordination.ts";
import type {
  ProjectionBaseline,
  ProjectionBaselineRepositoryShape,
} from "../../persistence/Services/ProjectionBaselines.ts";
import { BaseTestLayer } from "./ProjectionPipeline.test.helpers.ts";

const appendProject = Effect.fn("appendCooldownProject")(function* (name: string) {
  const eventStore = yield* OrchestrationEventStore;
  const now = "2026-08-03T00:00:00.000Z";
  const projectId = ProjectId.makeUnsafe(`cooldown-project-${name}`);
  yield* eventStore.append({
    type: "project.created",
    eventId: EventId.makeUnsafe(`cooldown-event-${name}`),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: now,
    commandId: CommandId.makeUnsafe(`cooldown-command-${name}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      projectId,
      title: "Cooldown project",
      workspaceRoot: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
});

it.layer(BaseTestLayer)("projection baseline single-flight", (it) => {
  it.effect("shares concurrent successful verification", () =>
    Effect.gen(function* () {
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      yield* appendProject("success");
      yield* pipeline.bootstrap;
      yield* Effect.all(
        [pipeline.ensureVerifiedBaselineThrough(1), pipeline.ensureVerifiedBaselineThrough(1)],
        { concurrency: 2 },
      );

      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_baselines WHERE verification_status = 'verified'
      `;
      assert.deepEqual(rows, [{ count: 1 }]);
    }),
  );
});

it.layer(BaseTestLayer)("projection baseline cooldown", (it) => {
  it.effect("fails fast during the bounded verification failure cooldown", () =>
    Effect.gen(function* () {
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      yield* appendProject("failure");
      yield* appendProject("failure-second");
      yield* pipeline.bootstrap;
      yield* sql`
        UPDATE orchestration_retention_state
        SET retained_through_sequence = 2
        WHERE singleton_id = 1
      `;

      const first = yield* Effect.exit(pipeline.ensureVerifiedBaselineThrough(2));
      const retainedCandidates = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM projection_baselines
        WHERE verification_status = 'candidate'
      `;
      assert.deepEqual(retainedCandidates, [{ count: 0 }]);
      yield* sql`
        UPDATE orchestration_retention_state
        SET retained_through_sequence = 0
        WHERE singleton_id = 1
      `;
      const second = yield* Effect.exit(pipeline.ensureVerifiedBaselineThrough(2));
      assert.equal(first._tag, "Failure");
      assert.equal(second._tag, "Failure");
      if (first._tag === "Failure" && second._tag === "Failure") {
        assert.equal(Cause.squash(first.cause), Cause.squash(second.cause));
      }

      assert.equal(PROJECTION_BASELINE_FAILURE_COOLDOWN_MS, 15 * 60 * 1000);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

const baselineAt = (sequence: number): ProjectionBaseline => ({
  baselineId: sequence,
  sequence,
  formatVersion: 1,
  payloadJson: "{}",
  payloadHash: `hash-${sequence}`,
  verificationStatus: "verified",
  verificationDetail: null,
  createdAt: "2026-08-03T00:00:00.000Z",
  verifiedAt: "2026-08-03T00:00:00.000Z",
});

const coordinatorBaselines = (
  latest: () => Option.Option<ProjectionBaseline>,
): ProjectionBaselineRepositoryShape => ({
  capturePayload: () => Effect.succeed("{}"),
  createCandidate: () => Effect.succeed(Option.none()),
  getById: () => Effect.succeed(Option.none()),
  latestVerified: () => Effect.succeed(latest()),
  markRejected: () => Effect.void,
  markVerified: () => Effect.void,
  restorePayload: () => Effect.void,
});

it.effect("extends an active baseline flight to the highest concurrent request", () =>
  Effect.gen(function* () {
    let verifiedSequence = 0;
    let compactCount = 0;
    const firstCompactStarted = yield* Deferred.make<void>();
    const releaseFirstCompact = yield* Deferred.make<void>();
    const ensure = yield* makeProjectionBaselineCoordinator({
      baselines: coordinatorBaselines(() =>
        verifiedSequence === 0 ? Option.none() : Option.some(baselineAt(verifiedSequence)),
      ),
      compact: Effect.gen(function* () {
        compactCount += 1;
        if (compactCount === 1) {
          yield* Deferred.succeed(firstCompactStarted, undefined);
          yield* Deferred.await(releaseFirstCompact);
        }
        verifiedSequence = compactCount;
      }),
    });

    const first = yield* ensure(1).pipe(Effect.forkChild);
    yield* Deferred.await(firstCompactStarted);
    const second = yield* ensure(2).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(releaseFirstCompact, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);

    assert.equal(compactCount, 2);
    assert.equal(verifiedSequence, 2);
  }),
);

it.effect("completes and clears an interrupted baseline flight", () =>
  Effect.gen(function* () {
    let compactCount = 0;
    let verifiedSequence = 0;
    const ensure = yield* makeProjectionBaselineCoordinator({
      baselines: coordinatorBaselines(() =>
        verifiedSequence === 0 ? Option.none() : Option.some(baselineAt(verifiedSequence)),
      ),
      compact: Effect.suspend(() => {
        compactCount += 1;
        if (compactCount === 1) return Effect.interrupt;
        verifiedSequence = 1;
        return Effect.void;
      }),
    });

    const interrupted = yield* Effect.exit(ensure(1));
    assert.equal(interrupted._tag, "Failure");
    yield* ensure(1);
    assert.equal(compactCount, 2);
  }),
);
