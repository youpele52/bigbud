import { assert, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { makeProjectionBaselineCoordinator } from "./ProjectionPipeline.baseline.coordination.ts";

// Regression for the packaged-app OOM: the cleanup recovery loop asks for coverage every
// 5 s, and each check used to load, hash and parse the whole (154 MB) verified payload.
const sequenceOnlyBaselines = (sequence: () => number | null) => {
  let sequenceReads = 0;
  return {
    get sequenceReads() {
      return sequenceReads;
    },
    baselines: {
      latestVerifiedSequence: () =>
        Effect.sync(() => {
          sequenceReads += 1;
          return Option.fromNullishOr(sequence());
        }),
      // The coordinator's type no longer exposes this; fail loudly if a cast reintroduces it.
      latestVerified: () => Effect.die(new Error("coverage checks must not load a payload")),
    },
  };
};

it.effect("answers covered requests from the verified sequence without compacting", () =>
  Effect.gen(function* () {
    let compactCount = 0;
    const fake = sequenceOnlyBaselines(() => 7);
    const ensure = yield* makeProjectionBaselineCoordinator({
      baselines: fake.baselines,
      compact: Effect.sync(() => {
        compactCount += 1;
      }),
    });

    for (let check = 0; check < 20; check += 1) yield* ensure(5);

    assert.equal(compactCount, 0);
    assert.equal(fake.sequenceReads, 20);
  }),
);

it.effect("compacts once when the verified sequence is behind, then reads the sequence again", () =>
  Effect.gen(function* () {
    let verified: number | null = null;
    let compactCount = 0;
    const fake = sequenceOnlyBaselines(() => verified);
    const ensure = yield* makeProjectionBaselineCoordinator({
      baselines: fake.baselines,
      compact: Effect.sync(() => {
        compactCount += 1;
        verified = 9;
      }),
    });

    yield* ensure(9);
    yield* ensure(9);

    assert.equal(compactCount, 1);
    assert.equal(fake.sequenceReads, 3);
  }),
);
