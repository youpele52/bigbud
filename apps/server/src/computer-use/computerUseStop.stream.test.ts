import type { ComputerUseActivitySnapshot } from "@bigbud/contracts/server/computerUseActivity.ts";
import { Deferred, Effect, Fiber, Queue, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { COMPUTER_USE_ACTIVITY_LINGER_MS } from "./computerUseActivity.logic.ts";
import { makeComputerUseActivityStream } from "./computerUseStop.ts";
import {
  BROWSER,
  DESKTOP,
  makeStopDriver,
  makeThread,
  setupStop,
} from "./computerUseStop.testSupport.ts";

describe("computer-use activity stream", () => {
  it("emits the current state, then each start, finish, stop and expiry", async () => {
    // The registry stamps actions with the wall clock; only skip ahead of it.
    let offsetMs = 0;
    const now = () => Date.now() + offsetMs;
    const seen = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { activity, deps, state, stop } = yield* setupStop(makeStopDriver().driver, now);
          const queue = yield* Queue.unbounded<ComputerUseActivitySnapshot>();
          yield* Effect.forkScoped(
            Stream.runForEach(makeComputerUseActivityStream(deps), (snapshot) =>
              Queue.offer(queue, snapshot),
            ),
          );
          const next = Queue.take(queue);
          const initial = yield* next;
          const gate = yield* Deferred.make<void>();
          const action = yield* Effect.forkChild(activity.track(DESKTOP, Deferred.await(gate)));
          const started = yield* next;
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(action);
          const finished = yield* next;
          yield* stop;
          const stopped = yield* next;
          yield* activity.track(BROWSER, Effect.void);
          yield* next;
          state.threads = state.threads.map((thread) =>
            thread.id === BROWSER.threadId ? makeThread(BROWSER.threadId, null) : thread,
          );
          offsetMs += COMPUTER_USE_ACTIVITY_LINGER_MS;
          const expired = yield* next;
          return [initial, started, finished, stopped, expired];
        }),
      ),
    );
    expect(seen.map((snapshot) => snapshot.active)).toEqual([false, true, true, false, false]);
    expect(seen[1]!.turns[0]).toMatchObject({
      actionInFlight: true,
      turnRunning: true,
      usedDesktop: true,
    });
    expect(seen[2]!.turns[0]).toMatchObject({ actionInFlight: false, turnRunning: true });
  }, 15_000);
});
