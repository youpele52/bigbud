import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import * as TestClock from "effect/testing/TestClock";

import { ACP_SESSION_STOP_CONCURRENCY, stopAcpSessions } from "./AcpAdapterSupport.ts";

// Cursor and Devin use this for both `stopAll` and their layer finalizer.
describe("stopAcpSessions", () => {
  it.effect("stops sessions concurrently, bounded, while stopping removes them from the map", () =>
    Effect.gen(function* () {
      const sessions = new Map(
        Array.from({ length: ACP_SESSION_STOP_CONCURRENCY + 4 }, (_, index) => [index, index]),
      );
      let running = 0;
      let peak = 0;
      const stopped: number[] = [];
      const stop = (id: number) =>
        Effect.gen(function* () {
          running += 1;
          peak = Math.max(peak, running);
          // Each agent takes its full SIGTERM-to-SIGKILL window to exit.
          yield* Effect.sleep("2 seconds");
          sessions.delete(id);
          stopped.push(id);
          running -= 1;
        });

      const fiber = yield* Effect.forkChild(stopAcpSessions(sessions.values(), stop));
      yield* TestClock.adjust("2 seconds");
      assert.strictEqual(stopped.length, ACP_SESSION_STOP_CONCURRENCY);
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(fiber);

      assert.strictEqual(peak, ACP_SESSION_STOP_CONCURRENCY);
      assert.strictEqual(stopped.length, ACP_SESSION_STOP_CONCURRENCY + 4);
      assert.strictEqual(sessions.size, 0);
    }),
  );
});
