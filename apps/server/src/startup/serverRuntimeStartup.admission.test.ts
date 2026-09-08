import { Deferred, Effect, Fiber, Option } from "effect";
import { describe, expect, it } from "vitest";

import { CommandAdmissionError } from "../command-admission/CommandAdmission.ts";
import { makeCommandGate } from "./serverRuntimeStartup.ts";

describe("server runtime startup command admission", () => {
  it("rejects after the worker-held entry and bounded queue are occupied", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const releaseWorker = yield* Deferred.make<void>();
          const workerTaken = yield* Deferred.make<void>();
          const commandEnqueued = yield* Deferred.make<void>();
          let enqueuedCount = 0;
          const gate = yield* makeCommandGate({
            capacity: 1,
            deadlineMs: 500,
            onCommandTaken: () => Deferred.succeed(workerTaken, undefined),
            onCommandEnqueued: () => {
              enqueuedCount += 1;
              return enqueuedCount === 2
                ? Deferred.succeed(commandEnqueued, undefined)
                : Effect.void;
            },
          });
          const first = yield* gate
            .enqueueCommand(Deferred.await(releaseWorker))
            .pipe(Effect.forkScoped);
          yield* Deferred.await(workerTaken);

          const second = yield* gate.enqueueCommand(Effect.void).pipe(Effect.forkScoped);
          yield* Deferred.await(commandEnqueued);

          const third = yield* gate.enqueueCommand(Effect.void).pipe(Effect.forkScoped);
          const overload = yield* Fiber.join(third).pipe(
            Effect.flip,
            Effect.timeoutOption("100 millis"),
          );
          yield* gate.signalCommandReady;
          yield* Deferred.succeed(releaseWorker, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
          return overload;
        }),
      ),
    );

    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value).toBeInstanceOf(CommandAdmissionError);
      expect(result.value).toMatchObject({
        code: "overloaded",
        queue: "startup-readiness",
      });
    }
  });
});
