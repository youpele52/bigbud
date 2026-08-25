import { ThreadId, TurnId, type VisibleBrowserCommand } from "@bigbud/contracts";
import { Effect, Fiber, Layer, Queue, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { VisibleBrowserControl } from "../Services/VisibleBrowserControl.ts";
import { VisibleBrowserControlLive } from "./VisibleBrowserControl.ts";

const THREAD_ID = ThreadId.makeUnsafe("visible-browser-resolve-thread");
const OTHER_THREAD_ID = ThreadId.makeUnsafe("visible-browser-resolve-other-thread");
const UNOWNED_THREAD_ID = ThreadId.makeUnsafe("visible-browser-resolve-unowned-thread");
const TURN_ID = TurnId.makeUnsafe("visible-browser-resolve-turn");
const RENDERER_ID = "visible-browser-resolve-renderer" as const;
const layer = VisibleBrowserControlLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

describe("VisibleBrowserControlLive.resolveThreadLease", () => {
  it("returns the most recently controlled tab owned by the calling thread", async () => {
    const resolved = await Effect.runPromise(
      Effect.gen(function* () {
        const control = yield* VisibleBrowserControl;
        const commands = yield* Queue.unbounded<VisibleBrowserCommand>();
        yield* Stream.runForEach(control.streamCommands(RENDERER_ID), (command) =>
          Queue.offer(commands, command),
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        const controlTab = (threadId: ThreadId, tabId?: string) =>
          Effect.gen(function* () {
            const execution = yield* control
              .execute({
                threadId,
                turnId: TURN_ID,
                action: { action: "capture", target: "visible", ...(tabId ? { tabId } : {}) },
              })
              .pipe(Effect.forkScoped);
            const command = yield* Queue.take(commands);
            const resultTabId = tabId ?? `browser:${command.leaseId}`;
            yield* control.complete({
              commandId: command.commandId,
              rendererId: RENDERER_ID,
              result: {
                action: "capture",
                summary: "Captured visible browser.",
                tabId: resultTabId,
                target: "visible",
              },
            });
            return yield* Fiber.join(execution);
          });

        const first = yield* controlTab(THREAD_ID);
        const single = yield* control.resolveThreadLease(THREAD_ID);
        const second = yield* controlTab(THREAD_ID);
        yield* controlTab(THREAD_ID, first.tabId);
        yield* controlTab(OTHER_THREAD_ID);
        return [
          first.tabId,
          single,
          second.tabId,
          yield* control.resolveThreadLease(THREAD_ID),
          yield* control.resolveThreadLease(UNOWNED_THREAD_ID),
        ] as const;
      }).pipe(Effect.provide(layer), Effect.scoped),
    );

    expect(resolved[1]).toBe(resolved[0]);
    expect(resolved[3]).toBe(resolved[0]);
    expect(resolved[3]).not.toBe(resolved[2]);
    expect(resolved[4]).toBeUndefined();
  });

  it("returns undefined when the calling thread has no lease", async () => {
    const resolved = await Effect.runPromise(
      Effect.gen(function* () {
        const control = yield* VisibleBrowserControl;
        return [
          yield* control.resolveThreadLease(THREAD_ID),
          yield* control.resolveThreadLease(OTHER_THREAD_ID),
        ] as const;
      }).pipe(Effect.provide(layer), Effect.scoped),
    );

    expect(resolved).toEqual([undefined, undefined]);
  });

  it("does not resolve a lease released when its thread stops running", async () => {
    const resolved = await Effect.runPromise(
      Effect.gen(function* () {
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
            tabId: "browser:released-tab",
            target: "visible",
          },
        });
        yield* Fiber.join(execution);
        yield* control.reconcileThread({
          threadId: THREAD_ID,
          activeTurnId: null,
          isRunning: false,
        });
        return yield* control.resolveThreadLease(THREAD_ID);
      }).pipe(Effect.provide(layer), Effect.scoped),
    );

    expect(resolved).toBeUndefined();
  });

  it("does not resolve a lease or retain durable activity after releasing its tab", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const control = yield* VisibleBrowserControl;
        const sql = yield* SqlClient.SqlClient;
        const commands = yield* Queue.unbounded<VisibleBrowserCommand>();
        yield* Stream.runForEach(control.streamCommands(RENDERER_ID), (command) =>
          Queue.offer(commands, command),
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        const capture = yield* control
          .execute({
            threadId: THREAD_ID,
            turnId: TURN_ID,
            action: { action: "capture", target: "visible" },
          })
          .pipe(Effect.forkScoped);
        const captureCommand = yield* Queue.take(commands);
        yield* control.complete({
          commandId: captureCommand.commandId,
          rendererId: RENDERER_ID,
          result: {
            action: "capture",
            summary: "Captured visible browser.",
            tabId: "browser:released-tab",
            target: "visible",
          },
        });
        const captured = yield* Fiber.join(capture);

        const release = yield* control
          .execute({
            threadId: THREAD_ID,
            turnId: TURN_ID,
            action: { action: "release_tab", target: "visible", tabId: captured.tabId! },
          })
          .pipe(Effect.forkScoped);
        const releaseCommand = yield* Queue.take(commands);
        yield* control.complete({
          commandId: releaseCommand.commandId,
          rendererId: RENDERER_ID,
          result: {
            action: "release_tab",
            summary: "Released visible browser tab.",
            tabId: captured.tabId,
            target: "visible",
          },
        });

        return {
          released: yield* Fiber.join(release),
          resolved: yield* control.resolveThreadLease(THREAD_ID),
          durableLeases: yield* sql<{ count: number }>`
            SELECT COUNT(*) AS count FROM thread_activity_leases WHERE thread_id = ${THREAD_ID}
          `,
        };
      }).pipe(Effect.provide(layer), Effect.scoped),
    );

    expect(result.released).toMatchObject({ action: "release_tab", target: "visible" });
    expect(result.resolved).toBeUndefined();
    expect(result.durableLeases).toEqual([{ count: 0 }]);
  });

  it("does not resolve a lease revoked by the renderer", async () => {
    const resolved = await Effect.runPromise(
      Effect.gen(function* () {
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
        const result = {
          action: "capture" as const,
          summary: "Captured visible browser.",
          tabId: "browser:revoked-tab",
          target: "visible" as const,
        };
        yield* control.complete({
          commandId: command.commandId,
          rendererId: RENDERER_ID,
          result,
        });
        const completed = yield* Fiber.join(execution);
        yield* control.revokeLease({
          leaseId: completed.leaseId!,
          rendererId: RENDERER_ID,
          tabId: result.tabId,
        });
        return yield* control.resolveThreadLease(THREAD_ID);
      }).pipe(Effect.provide(layer), Effect.scoped),
    );

    expect(resolved).toBeUndefined();
  });

  it("fully releases an established lease after command failure and reacquires on auto-routing", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const control = yield* VisibleBrowserControl;
        const sql = yield* SqlClient.SqlClient;
        const commands = yield* Queue.unbounded<VisibleBrowserCommand>();
        yield* Stream.runForEach(control.streamCommands(RENDERER_ID), (command) =>
          Queue.offer(commands, command),
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        const initial = yield* control
          .execute({
            threadId: THREAD_ID,
            turnId: TURN_ID,
            action: { action: "capture", target: "visible" },
          })
          .pipe(Effect.forkScoped);
        const initialCommand = yield* Queue.take(commands);
        yield* control.complete({
          commandId: initialCommand.commandId,
          rendererId: RENDERER_ID,
          result: {
            action: "capture",
            summary: "Captured visible browser.",
            tabId: "browser:failed-tab",
            target: "visible",
          },
        });
        const initialResult = yield* Fiber.join(initial);

        const failed = yield* control
          .execute({
            threadId: THREAD_ID,
            turnId: TURN_ID,
            action: { action: "reload", target: "visible", tabId: initialResult.tabId! },
          })
          .pipe(Effect.forkScoped);
        const failedCommand = yield* Queue.take(commands);
        yield* control.complete({
          commandId: failedCommand.commandId,
          rendererId: RENDERER_ID,
          error: "Renderer command failed.",
        });
        const failedExit = yield* Effect.exit(Fiber.join(failed));
        const leasesAfterFailure = yield* control.getLeases(RENDERER_ID);
        const durableAfterFailure = yield* sql<{ count: number }>`
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
          durableAfterFailure,
          failedExit,
          initialLeaseId: initialResult.leaseId,
          leasesAfterFailure,
          reacquired: yield* Fiber.join(reacquired),
        };
      }).pipe(Effect.provide(layer), Effect.scoped),
    );

    expect(result.failedExit._tag).toBe("Failure");
    expect(result.leasesAfterFailure).toEqual([]);
    expect(result.durableAfterFailure).toEqual([{ count: 0 }]);
    expect(result.reacquired).toMatchObject({
      tabId: "browser:reacquired-tab",
      target: "visible",
    });
    expect(result.reacquired.leaseId).not.toBe(result.initialLeaseId);
  });

  it("keeps the reconnect error for an owned lease after its renderer disconnects", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const control = yield* VisibleBrowserControl;
        const commands = yield* Queue.unbounded<VisibleBrowserCommand>();
        const renderer = yield* Stream.runForEach(control.streamCommands(RENDERER_ID), (command) =>
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
            tabId: "browser:reconnecting-tab",
            target: "visible",
          },
        });
        yield* Fiber.join(execution);
        yield* Fiber.interrupt(renderer);
        yield* Effect.yieldNow;

        return yield* Effect.flip(
          control.execute({
            threadId: THREAD_ID,
            turnId: TURN_ID,
            action: { action: "capture", target: "visible", tabId: "browser:reconnecting-tab" },
          }),
        );
      }).pipe(Effect.provide(layer), Effect.scoped),
    );

    expect(error.message).toBe(
      "The visible browser tab is reconnecting. Try again once it is connected.",
    );
  });
});
