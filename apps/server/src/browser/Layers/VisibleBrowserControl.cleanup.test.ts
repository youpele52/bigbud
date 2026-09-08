import { ThreadId, TurnId, type VisibleBrowserCommand } from "@bigbud/contracts";
import { Effect, Fiber, Layer, Queue, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { VisibleBrowserControl } from "../Services/VisibleBrowserControl.ts";
import { VisibleBrowserControlLive } from "./VisibleBrowserControl.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-visible-browser-cleanup");
const TURN_ID = TurnId.makeUnsafe("turn-visible-browser-cleanup");
const RENDERER_ID = "renderer-visible-browser-cleanup" as const;
const NEXT_RENDERER_ID = "renderer-visible-browser-cleanup-next" as const;
const layer = VisibleBrowserControlLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const testClockLayer = Layer.merge(layer, TestClock.layer());

const setupEstablishedLease = Effect.fn("setupEstablishedVisibleBrowserLease")(function* () {
  const control = yield* VisibleBrowserControl;
  const commands = yield* Queue.unbounded<VisibleBrowserCommand>();
  yield* Stream.runForEach(control.streamCommands(RENDERER_ID), (command) =>
    Queue.offer(commands, command),
  ).pipe(Effect.forkScoped);
  yield* Effect.yieldNow;
  const execution = yield* control
    .execute({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      action: { action: "capture", target: "visible" },
    })
    .pipe(Effect.forkScoped);
  const command = yield* Queue.take(commands);
  yield* control.complete({
    commandId: command.commandId,
    rendererId: RENDERER_ID,
    result: {
      action: "capture",
      summary: "Captured visible browser.",
      tabId: "browser:cleanup-tab",
      target: "visible",
    },
  });
  const result = yield* Fiber.join(execution);
  return { commands, control, result } as const;
});

describe("VisibleBrowserControl cleanup", () => {
  it("permits clean auto-routing reacquisition after a reload-orphaned lease is revoked", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { commands, control, result: established } = yield* setupEstablishedLease();
        yield* control.revokeLease({
          leaseId: established.leaseId!,
          rendererId: RENDERER_ID,
          tabId: established.tabId!,
        });
        const leasesAfterRevoke = yield* control.getLeases(RENDERER_ID);

        const reacquired = yield* control
          .execute({
            threadId: THREAD_ID,
            turnId: TURN_ID,
            action: { action: "capture", target: "visible" },
          })
          .pipe(Effect.forkScoped);
        const command = yield* Queue.take(commands);
        yield* control.complete({
          commandId: command.commandId,
          rendererId: RENDERER_ID,
          result: {
            action: "capture",
            summary: "Captured a replacement visible browser tab.",
            tabId: "browser:replacement-tab",
            target: "visible",
          },
        });

        return {
          established,
          leasesAfterRevoke,
          reacquired: yield* Fiber.join(reacquired),
        };
      }).pipe(Effect.provide(layer), Effect.scoped),
    );

    expect(result.leasesAfterRevoke).toEqual([]);
    expect(result.reacquired).toMatchObject({ tabId: "browser:replacement-tab" });
    expect(result.reacquired.leaseId).not.toBe(result.established.leaseId);
  });

  it("fully releases a timed-out command lease and permits auto-routing to reacquire", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { commands, control, result: established } = yield* setupEstablishedLease();
        const timedOut = yield* control
          .execute({
            threadId: THREAD_ID,
            turnId: TURN_ID,
            action: { action: "reload", target: "visible", tabId: established.tabId! },
          })
          .pipe(Effect.forkScoped);
        yield* Queue.take(commands);
        yield* TestClock.adjust("15 seconds");
        const timedOutExit = yield* Effect.exit(Fiber.join(timedOut));
        const release = yield* Queue.take(commands);
        const leasesAfterTimeout = yield* control.getLeases(RENDERER_ID);
        const durableAfterTimeout = yield* sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM thread_activity_leases WHERE thread_id = ${THREAD_ID}
        `;

        const reacquired = yield* control
          .execute({
            threadId: THREAD_ID,
            turnId: TURN_ID,
            action: { action: "capture", target: "visible" },
          })
          .pipe(Effect.forkScoped);
        const reacquiredCommand = yield* Queue.take(commands);
        yield* control.complete({
          commandId: reacquiredCommand.commandId,
          rendererId: RENDERER_ID,
          result: {
            action: "capture",
            summary: "Captured visible browser again.",
            tabId: "browser:reacquired-tab",
            target: "visible",
          },
        });

        return {
          durableAfterTimeout,
          established,
          leasesAfterTimeout,
          reacquired: yield* Fiber.join(reacquired),
          release,
          timedOutExit,
        };
      }).pipe(Effect.provide(testClockLayer), Effect.scoped),
    );

    expect(result.timedOutExit._tag).toBe("Failure");
    expect(result.release).toMatchObject({
      leaseId: result.established.leaseId,
      action: { action: "release_tab", tabId: result.established.tabId },
    });
    expect(result.leasesAfterTimeout).toEqual([]);
    expect(result.durableAfterTimeout).toEqual([{ count: 0 }]);
    expect(result.reacquired.leaseId).not.toBe(result.established.leaseId);
  });

  it("fully releases an interrupted command lease", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { commands, control, result: established } = yield* setupEstablishedLease();
        const interrupted = yield* control
          .execute({
            threadId: THREAD_ID,
            turnId: TURN_ID,
            action: { action: "reload", target: "visible", tabId: established.tabId! },
          })
          .pipe(Effect.forkScoped);
        yield* Queue.take(commands);
        yield* Fiber.interrupt(interrupted);

        const release = yield* Queue.take(commands);
        const leases = yield* control.getLeases(RENDERER_ID);
        const durable = yield* sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM thread_activity_leases WHERE thread_id = ${THREAD_ID}
        `;
        const reacquired = yield* control
          .execute({
            threadId: THREAD_ID,
            turnId: TURN_ID,
            action: { action: "capture", target: "visible" },
          })
          .pipe(Effect.forkScoped);
        const reacquiredCommand = yield* Queue.take(commands);
        yield* control.complete({
          commandId: reacquiredCommand.commandId,
          rendererId: RENDERER_ID,
          result: {
            action: "capture",
            summary: "Captured after interruption.",
            tabId: "browser:after-interruption",
            target: "visible",
          },
        });

        return {
          durable,
          leases,
          reacquired: yield* Fiber.join(reacquired),
          release,
        };
      }).pipe(Effect.provide(layer), Effect.scoped),
    );

    expect(result.release.action).toMatchObject({
      action: "release_tab",
      tabId: "browser:cleanup-tab",
    });
    expect(result.leases).toEqual([]);
    expect(result.durable).toEqual([{ count: 0 }]);
    expect(result.reacquired).toMatchObject({ tabId: "browser:after-interruption" });
  });

  it("settles every concurrent pending command when one command errors", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { commands, control, result: established } = yield* setupEstablishedLease();
        const first = yield* control
          .execute({
            threadId: THREAD_ID,
            turnId: TURN_ID,
            action: { action: "reload", target: "visible", tabId: established.tabId! },
          })
          .pipe(Effect.forkScoped);
        const second = yield* control
          .execute({
            threadId: THREAD_ID,
            turnId: TURN_ID,
            action: { action: "capture", target: "visible", tabId: established.tabId! },
          })
          .pipe(Effect.forkScoped);
        const firstCommand = yield* Queue.take(commands);
        yield* Queue.take(commands);
        yield* control.complete({
          commandId: firstCommand.commandId,
          rendererId: RENDERER_ID,
          error: "Renderer command failed.",
        });

        return {
          first: yield* Effect.exit(Fiber.join(first)),
          leases: yield* control.getLeases(RENDERER_ID),
          second: yield* Effect.exit(Fiber.join(second)),
        };
      }).pipe(Effect.provide(layer), Effect.scoped),
    );

    expect(result.first._tag).toBe("Failure");
    expect(result.second._tag).toBe("Failure");
    expect(result.leases).toEqual([]);
  });

  it("forgets a closed agent-created tab when its lease was removed before completion", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { commands, control, result: established } = yield* setupEstablishedLease();
        const close = yield* control
          .execute({
            threadId: THREAD_ID,
            turnId: TURN_ID,
            action: { action: "close_tab", target: "visible", tabId: established.tabId! },
          })
          .pipe(Effect.forkScoped);
        const closeCommand = yield* Queue.take(commands);
        const leaseRemovingCommand = yield* control
          .execute({
            threadId: THREAD_ID,
            turnId: TURN_ID,
            action: { action: "capture", target: "visible", tabId: established.tabId! },
          })
          .pipe(Effect.forkScoped);
        const captureCommand = yield* Queue.take(commands);
        yield* control.complete({
          commandId: captureCommand.commandId,
          rendererId: RENDERER_ID,
          result: {
            action: "capture",
            summary: "The tab closed before capture completed.",
            target: "visible",
          },
        });
        yield* Fiber.join(leaseRemovingCommand);
        yield* control.complete({
          commandId: closeCommand.commandId,
          rendererId: RENDERER_ID,
          result: {
            action: "close_tab",
            summary: "Closed visible browser tab.",
            tabId: established.tabId!,
            target: "visible",
          },
        });
        yield* Fiber.join(close);

        const nextCommands = yield* Queue.unbounded<VisibleBrowserCommand>();
        yield* Stream.runForEach(control.streamCommands(NEXT_RENDERER_ID), (command) =>
          Queue.offer(nextCommands, command),
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        const subsequentClose = yield* control
          .execute({
            threadId: THREAD_ID,
            turnId: TURN_ID,
            action: { action: "close_tab", target: "visible", tabId: established.tabId! },
          })
          .pipe(Effect.forkScoped);
        const subsequentCommand = yield* Queue.take(nextCommands);
        yield* control.complete({
          commandId: subsequentCommand.commandId,
          rendererId: NEXT_RENDERER_ID,
          result: {
            action: "close_tab",
            summary: "Confirmed stale registry cleanup.",
            tabId: established.tabId!,
            target: "visible",
          },
        });

        return {
          rendererId: subsequentCommand.rendererId,
          subsequentClose: yield* Fiber.join(subsequentClose),
        };
      }).pipe(Effect.provide(layer), Effect.scoped),
    );

    expect(result.rendererId).toBe(NEXT_RENDERER_ID);
    expect(result.subsequentClose).toMatchObject({ action: "close_tab" });
  });
});
