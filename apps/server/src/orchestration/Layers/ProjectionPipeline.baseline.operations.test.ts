import { assert, it } from "@effect/vitest";
import { Cause, Effect, Option } from "effect";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import type {
  ProjectionBaseline,
  ProjectionBaselineRepositoryShape,
} from "../../persistence/Services/ProjectionBaselines.ts";
import type { OrchestrationEventStoreShape } from "../../persistence/Services/OrchestrationEventStore.ts";
import { makeProjectionBaselineOperations } from "./ProjectionPipeline.baseline.ts";

const candidate: ProjectionBaseline = {
  baselineId: 17,
  sequence: 17,
  formatVersion: 1,
  payloadJson: "{}",
  payloadHash: "hash-17",
  verificationStatus: "candidate",
  verificationDetail: null,
  createdAt: "2026-08-03T00:00:00.000Z",
  verifiedAt: null,
};

const makeBaselines = (input: {
  readonly latest?: Option.Option<ProjectionBaseline>;
  readonly markRejected?: ProjectionRepositoryError;
}) => {
  const rejected: Array<{ readonly id: number; readonly detail: string }> = [];
  const baselines: ProjectionBaselineRepositoryShape = {
    capturePayload: () => Effect.succeed("{}"),
    createCandidate: () => Effect.succeed(Option.some(candidate)),
    getById: () => Effect.succeed(Option.some(candidate)),
    latestVerified: () => Effect.succeed(input.latest ?? Option.none()),
    markRejected: (id, detail) => {
      rejected.push({ id, detail });
      return input.markRejected ? Effect.fail(input.markRejected) : Effect.void;
    },
    markVerified: () => Effect.void,
    restorePayload: () => Effect.void,
  };
  return { baselines, rejected };
};

const makeOperations = (input: {
  readonly baselines: ProjectionBaselineRepositoryShape;
  readonly verifyCandidate: (
    candidate: ProjectionBaseline,
    source: Option.Option<ProjectionBaseline>,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
}) =>
  makeProjectionBaselineOperations({
    eventStore: {} as OrchestrationEventStoreShape,
    baselines: input.baselines,
    projectorNames: [],
    verifyCandidate: input.verifyCandidate,
  });

it.effect("rejects a candidate when verification throws and preserves the primary error", () =>
  Effect.gen(function* () {
    const primary = new PersistenceDecodeError({
      operation: "replay",
      issue: "replay gap",
      cause: new Error("gap"),
    });
    const { baselines, rejected } = makeBaselines({});
    const exit = yield* Effect.exit(
      makeOperations({
        baselines,
        verifyCandidate: () => Effect.fail(primary),
      }).verify(candidate),
    );

    assert.equal(exit._tag, "Failure");
    if (exit._tag === "Failure") {
      assert.equal(Cause.squash(exit.cause), primary);
    }
    assert.deepEqual(rejected, [
      { id: 17, detail: "terminal projection baseline verification failure" },
    ]);
  }),
);

it.effect("rejects mismatches and does not reject a cooperatively interrupted candidate", () =>
  Effect.gen(function* () {
    const mismatch = makeBaselines({});
    const mismatchResult = yield* makeOperations({
      baselines: mismatch.baselines,
      verifyCandidate: () => Effect.succeed(false),
    }).verify(candidate);
    assert.isFalse(mismatchResult);
    assert.equal(mismatch.rejected.length, 1);

    const interrupted = makeBaselines({});
    const interruptedExit = yield* Effect.exit(
      makeOperations({
        baselines: interrupted.baselines,
        verifyCandidate: () => Effect.interrupt,
      }).verify(candidate),
    );
    assert.equal(interruptedExit._tag, "Failure");
    assert.equal(interrupted.rejected.length, 0);
  }),
);

it.effect("does not mask a verification error when candidate cleanup fails", () =>
  Effect.gen(function* () {
    const primary = new PersistenceSqlError({
      operation: "replay",
      detail: "replay failed",
    });
    const cleanup = new PersistenceSqlError({
      operation: "reject",
      detail: "reject failed",
    });
    const { baselines } = makeBaselines({ markRejected: cleanup });
    const exit = yield* Effect.exit(
      makeOperations({
        baselines,
        verifyCandidate: () => Effect.fail(primary),
      }).verify(candidate),
    );

    assert.equal(exit._tag, "Failure");
    if (exit._tag === "Failure") assert.equal(Cause.squash(exit.cause), primary);
  }),
);

it.effect("rejects a candidate after a verification defect without changing the defect", () =>
  Effect.gen(function* () {
    const primary = new Error("verification defect");
    const { baselines, rejected } = makeBaselines({});
    const exit = yield* Effect.exit(
      makeOperations({
        baselines,
        verifyCandidate: () => Effect.die(primary),
      }).verify(candidate),
    );

    assert.equal(exit._tag, "Failure");
    if (exit._tag === "Failure") assert.equal(Cause.squash(exit.cause), primary);
    assert.deepEqual(rejected, [
      { id: 17, detail: "terminal projection baseline verification failure" },
    ]);
  }),
);
