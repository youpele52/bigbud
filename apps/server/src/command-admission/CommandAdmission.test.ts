import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import {
  CommandAdmissionError,
  makeBoundedCommandAdmission,
  withCommandAdmissionDeadline,
} from "./CommandAdmission.ts";

it.effect("keeps lifecycle admission available during external stream saturation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const admission = yield* makeBoundedCommandAdmission<string>({
        capacity: 3,
        queue: "orchestration",
        reservedCapacity: 1,
      });

      // Provider runtime events occupy every externally available slot.
      yield* admission.offer("provider-stream-1");
      yield* admission.offer("provider-stream-2");
      const externalError = yield* admission.offer("provider-stream-rejected").pipe(Effect.flip);
      assert.instanceOf(externalError, CommandAdmissionError);
      assert.equal(externalError.code, "overloaded");

      yield* admission.offer("lifecycle-flush", "internal");
      assert.equal(yield* admission.take, "provider-stream-1");
      assert.equal(yield* admission.take, "provider-stream-2");
      assert.equal(yield* admission.take, "lifecycle-flush");
    }),
  ),
);

it.effect("rejects a full startup-readiness admission queue without queuing work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const admission = yield* makeBoundedCommandAdmission<string>({
        capacity: 1,
        queue: "startup-readiness",
      });

      yield* admission.offer("first");
      const error = yield* admission.offer("second").pipe(Effect.flip);
      assert.equal(error.queue, "startup-readiness");
      assert.equal(yield* admission.take, "first");
    }),
  ),
);

it.effect("reports a typed deadline without cancelling the queued work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const deferred = yield* Deferred.make<string>();
      const fiber = yield* withCommandAdmissionDeadline(Deferred.await(deferred), {
        queue: "startup-readiness",
        deadlineMs: 10,
      }).pipe(Effect.forkScoped);

      yield* TestClock.adjust("11 millis");
      const error = yield* Effect.flip(Fiber.join(fiber));
      assert.instanceOf(error, CommandAdmissionError);
      assert.equal(error.code, "deadline_exceeded");

      yield* Deferred.succeed(deferred, "still available");
      assert.equal(yield* Deferred.await(deferred), "still available");
    }),
  ),
);
