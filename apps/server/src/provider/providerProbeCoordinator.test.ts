import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Ref } from "effect";
import * as Semaphore from "effect/Semaphore";

import { withProviderProbePermit } from "./providerProbeCoordinator.ts";

describe("provider probe coordination", () => {
  it.layer(NodeServices.layer, { excludeTestServices: true })("queued probes", (it) => {
    it.effect("starts the timeout only after a probe acquires capacity", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const semaphore = yield* Semaphore.make(1);
          const blockerStarted = yield* Deferred.make<void>();
          const releaseBlocker = yield* Deferred.make<void>();
          const executions = yield* Ref.make(0);

          yield* semaphore
            .withPermits(1)(
              Deferred.succeed(blockerStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseBlocker)),
              ),
            )
            .pipe(Effect.forkScoped);
          yield* Deferred.await(blockerStarted);

          const queued = yield* withProviderProbePermit(
            semaphore,
            Ref.update(executions, (count) => count + 1).pipe(Effect.as("ready")),
            "10 millis",
          ).pipe(Effect.forkScoped);

          yield* Effect.sleep("30 millis");
          assert.strictEqual(yield* Ref.get(executions), 0);
          const completedWhileQueued = yield* Fiber.join(queued).pipe(
            Effect.timeoutOption("1 millis"),
          );
          assert.isTrue(Option.isNone(completedWhileQueued));

          yield* Deferred.succeed(releaseBlocker, undefined);
          assert.deepStrictEqual(yield* Fiber.join(queued), Option.some("ready"));
          assert.strictEqual(yield* Ref.get(executions), 1);
        }),
      ),
    );
  });
});
