import { EventId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { ProviderRuntimeEvent } from "@bigbud/contracts/orchestration/providerRuntime.events.ts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Logger, Scope } from "effect";
import * as TestClock from "effect/testing/TestClock";

import {
  ACP_SESSION_CLEANUP_TIMEOUT,
  ACP_SESSION_STOP_WAIT,
  makeAcpSessionStop,
  type AcpStoppableSession,
} from "./AcpSessionStop.ts";

/** A session whose scope close stands in for the ACP agent's SIGTERM/SIGKILL release. */
const harness = (options: {
  readonly bridgeCleanup?: () => Promise<void>;
  readonly notificationFiber?: Fiber.Fiber<void, never>;
  readonly closeTakes?: Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const timeline: string[] = [];
    const scope = yield* Scope.make();
    yield* Scope.addFinalizer(
      scope,
      (options.closeTakes ?? Effect.void).pipe(
        Effect.andThen(Effect.sync(() => timeline.push("agent:released"))),
      ),
    );
    const session: AcpStoppableSession = {
      threadId: ThreadId.makeUnsafe("thread-acp-stop"),
      sessionEpoch: 3,
      scope,
      ...(options.bridgeCleanup ? { orchestrationBridgeCleanup: options.bridgeCleanup } : {}),
      notificationFiber: options.notificationFiber,
      stopped: false,
    };
    const sessions = new Map([[session.threadId, session]]);
    const events: ProviderRuntimeEvent[] = [];
    const stop = makeAcpSessionStop({
      provider: "cursor",
      sessions,
      settlePending: () => Effect.sync(() => timeline.push("pending:settled")),
      offerRuntimeEvent: (event) => Effect.sync(() => events.push(event)),
      makeEventStamp: () =>
        Effect.succeed({ eventId: EventId.makeUnsafe("event-1"), createdAt: "2026-10-22" }),
    });
    return { session, sessions, events, timeline, stop };
  });

// Cursor and Devin both stop sessions through this (stopSession, stopAll and their finalizer).
describe("makeAcpSessionStop", () => {
  it.effect("still releases the agent when cleanup before the scope close hangs", () => {
    const warnings: string[] = [];
    const logger = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(JSON.stringify(message));
    });
    return Effect.gen(function* () {
      const hungFiber = yield* Effect.forkDetach(Effect.uninterruptible(Effect.never));
      const { session, sessions, events, timeline, stop } = yield* harness({
        bridgeCleanup: () => new Promise<void>(() => undefined),
        notificationFiber: hungFiber,
      });

      const fiber = yield* Effect.forkChild(stop(session));
      yield* TestClock.adjust(ACP_SESSION_CLEANUP_TIMEOUT);
      yield* TestClock.adjust(ACP_SESSION_CLEANUP_TIMEOUT);
      yield* Fiber.join(fiber);

      assert.deepStrictEqual(timeline, ["pending:settled", "agent:released"]);
      assert.strictEqual(sessions.size, 0);
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0]?.type, "session.exited");
      // Each capped step is logged so a slow cleanup can be traced in packaged builds.
      assert.strictEqual(warnings.length, 2);
      assert.include(warnings[0], "notificationFiber");
      assert.include(warnings[1], "orchestrationBridgeCleanup");
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });

  it.effect("makes a second stop wait for one in flight instead of skipping it", () =>
    Effect.gen(function* () {
      const { session, events, timeline, stop } = yield* harness({
        closeTakes: Effect.sleep("2 seconds"),
      });

      // stop-all timed out and left this stop running; the adapter finalizer stops again.
      const first = yield* Effect.forkDetach(stop(session));
      yield* Effect.yieldNow;
      assert.isTrue(session.stopped);
      const second = yield* Effect.forkChild(stop(session));
      yield* TestClock.adjust("1999 millis");
      assert.isUndefined(second.pollUnsafe());
      yield* TestClock.adjust("1 millis");
      yield* Fiber.join(second);
      yield* Fiber.join(first);

      assert.deepStrictEqual(timeline, ["pending:settled", "agent:released"]);
      assert.strictEqual(events.length, 1);
    }),
  );

  it.effect("bounds how long a second stop waits for a stuck one", () =>
    Effect.gen(function* () {
      const { session, stop } = yield* harness({ closeTakes: Effect.never });

      yield* Effect.forkDetach(stop(session));
      yield* Effect.yieldNow;
      const second = yield* Effect.forkChild(stop(session));
      yield* TestClock.adjust(ACP_SESSION_STOP_WAIT);
      yield* Fiber.join(second);
    }),
  );
});
