import { assert, it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import { TestClock } from "effect/testing";

import { recoverCanonicalPruningCandidates } from "./DirectResourceCleanupRecovery.ts";
import { makeCoverageBackoff } from "./DirectResourceCleanupRecovery.backoff.ts";

it.effect("backs off unprogressable baseline coverage instead of retrying every tick", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const finalized = yield* Ref.make(0);
    const succeed = yield* Ref.make(false);
    const coverageBackoff = makeCoverageBackoff(5_000, 20_000);
    const tick = recoverCanonicalPruningCandidates({
      candidates: [523178],
      requiredSequence: (sequence) => sequence,
      ensureCoverage: () =>
        Effect.gen(function* () {
          yield* Ref.update(attempts, (count) => count + 1);
          if (!(yield* Ref.get(succeed))) return yield* Effect.fail("not covered");
        }),
      finalizeCandidate: () => Ref.update(finalized, (count) => count + 1),
      coverageBackoff,
    });
    const tickEvery5s = (count: number) =>
      Effect.gen(function* () {
        for (let index = 0; index < count; index++) {
          yield* tick;
          yield* TestClock.adjust("5 seconds");
        }
      });

    // Attempts at 0s, 5s, 15s, 35s and 55s (delay 5s, 10s, 20s, then capped at 20s):
    // 5 attempts over 12 ticks (60s) instead of 12.
    yield* tickEvery5s(12);
    assert.equal(yield* Ref.get(attempts), 5);
    assert.equal(coverageBackoff.retryDelayMs(), 20_000);
    assert.equal(yield* Ref.get(finalized), 0);

    yield* Ref.set(succeed, true);
    yield* tickEvery5s(4);
    assert.equal(yield* Ref.get(attempts), 6);
    assert.equal(yield* Ref.get(finalized), 1);
    assert.equal(coverageBackoff.retryDelayMs(), 0);
  }).pipe(Effect.provide(TestClock.layer())),
);
