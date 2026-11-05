import type { OrchestrationCommand } from "@bigbud/contracts";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";

import { ComputerUseAdmission } from "./computerUseAdmission.ts";
import {
  BROWSER,
  DESKTOP,
  makeStopDriver as makeDriver,
  makeThread,
  setupStop,
  turnId,
} from "./computerUseStop.testSupport.ts";
import type { CuaDriverShape } from "./Services/CuaDriver.ts";

const interrupted = (dispatched: ReadonlyArray<OrchestrationCommand>) =>
  dispatched
    .flatMap((command) => (command.type === "thread.turn.interrupt" ? [command] : []))
    .map((command) => [command.threadId, command.turnId, command.sessionEpoch])
    .toSorted();

describe("stopComputerUse", () => {
  it("interrupts exactly the turns using computer use and resets the driver once", async () => {
    const { driver, stopAllActivity } = makeDriver();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { activity, dispatched, stop } = yield* setupStop(driver);
        // Desktop: the tool call already returned (the driver may still be typing).
        yield* activity.track(DESKTOP, Effect.void);
        // Browser surface: an action still in flight.
        const gate = yield* Deferred.make<void>();
        yield* Effect.forkChild(activity.track(BROWSER, Deferred.await(gate)));
        yield* Effect.yieldNow;
        const stopped = yield* stop;
        yield* Deferred.succeed(gate, undefined);
        return { stopped, interrupts: interrupted(dispatched) };
      }),
    );
    expect(result.interrupts).toEqual([
      [BROWSER.threadId, BROWSER.turnId, 3],
      [DESKTOP.threadId, DESKTOP.turnId, 3],
    ]);
    expect(stopAllActivity).toHaveBeenCalledOnce();
    expect(result.stopped).toEqual({
      active: true,
      interruptedThreadIds: [BROWSER.threadId, DESKTOP.threadId],
      failedThreadIds: [],
      driverReset: "reset",
      driverResetError: null,
    });
  });

  it("resets the driver for a lingering desktop action whose turn ended, without interrupting", async () => {
    const { driver, stopAllActivity } = makeDriver();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { activity, dispatched, state, stop } = yield* setupStop(driver);
        yield* activity.track(DESKTOP, Effect.void);
        state.threads = state.threads.map((thread) =>
          thread.id === DESKTOP.threadId ? makeThread(DESKTOP.threadId, null) : thread,
        );
        return { stopped: yield* stop, interrupts: interrupted(dispatched) };
      }),
    );
    expect(result.interrupts).toEqual([]);
    expect(stopAllActivity).toHaveBeenCalledOnce();
    expect(result.stopped.driverReset).toBe("reset");
  });

  it("leaves the Cua driver alone when only the browser surface was used", async () => {
    const { driver, stopAllActivity } = makeDriver();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { activity, dispatched, stop } = yield* setupStop(driver);
        yield* activity.track(BROWSER, Effect.void);
        return { stopped: yield* stop, interrupts: interrupted(dispatched) };
      }),
    );
    expect(stopAllActivity).not.toHaveBeenCalled();
    expect(result.interrupts).toEqual([[BROWSER.threadId, BROWSER.turnId, 3]]);
    expect(result.stopped.driverReset).toBe("not-needed");
  });

  it("does nothing when no computer use is active", async () => {
    const { driver, stopAllActivity } = makeDriver();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { dispatched, stop } = yield* setupStop(driver);
        return { stopped: yield* stop, dispatched };
      }),
    );
    expect(result.dispatched).toEqual([]);
    expect(stopAllActivity).not.toHaveBeenCalled();
    expect(result.stopped).toMatchObject({ active: false, driverReset: "not-needed" });
  });

  it("stops a turn that started computer use while an earlier Stop was still resetting", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const { driver, stopAllActivity } = makeDriver(
          Deferred.await(gate).pipe(Effect.as("reset" as const)),
        );
        const { activity, dispatched, stop } = yield* setupStop(driver);
        yield* activity.track(DESKTOP, Effect.void);
        const first = yield* Effect.forkChild(stop);
        yield* Effect.yieldNow;
        // A different turn starts computer use while the first daemon reset is still running.
        yield* activity.track(BROWSER, Effect.void);
        const second = yield* Effect.forkChild(stop);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(gate, undefined);
        const results = [yield* Fiber.join(first), yield* Fiber.join(second)];
        return { results, resets: stopAllActivity.mock.calls.length, dispatched };
      }),
    );
    expect(result.results.map((stopped) => stopped.interruptedThreadIds)).toEqual([
      [DESKTOP.threadId],
      [BROWSER.threadId],
    ]);
    expect(interrupted(result.dispatched)).toHaveLength(2);
    // The second press only needed the browser turn, so it did not touch the driver.
    expect(result.resets).toBe(1);
  });

  it("fails a stopped turn's next action and makes earlier admissions stale", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { activity, stop } = yield* setupStop(makeDriver().driver);
        const ran = vi.fn();
        const gate = yield* Deferred.make<void>();
        const admitted = yield* Effect.forkChild(
          activity.track(
            DESKTOP,
            Deferred.await(gate).pipe(
              Effect.andThen(ComputerUseAdmission.asEffect()),
              Effect.map((admission) => admission.isCurrent()),
            ),
          ),
        );
        yield* Effect.yieldNow;
        yield* stop;
        yield* Deferred.succeed(gate, undefined);
        const currentAfterStop = yield* Fiber.join(admitted);
        const blocked = yield* Effect.exit(activity.track(DESKTOP, Effect.sync(ran)));
        const nextTurn = yield* Effect.exit(
          activity.track({ ...DESKTOP, turnId: turnId("d2") }, Effect.sync(ran)),
        );
        return { currentAfterStop, blocked, nextTurn, runs: ran.mock.calls.length };
      }),
    );
    expect(result.currentAfterStop).toBe(false);
    expect(Exit.isFailure(result.blocked)).toBe(true);
    expect(Exit.isSuccess(result.nextTurn)).toBe(true);
    expect(result.runs).toBe(1);
  });

  it("reports a failed reset, a missing driver, and a driver that was not running", async () => {
    const failing = {
      stopAllActivity: () => Effect.fail(new Error("socket was not released")),
    } as unknown as CuaDriverShape;
    const [failed, missing, idle] = await Effect.runPromise(
      Effect.forEach([failing, null, makeDriver(Effect.succeed("idle")).driver], (driver) =>
        Effect.gen(function* () {
          const { activity, stop } = yield* setupStop(driver);
          yield* activity.track(DESKTOP, Effect.void);
          return yield* stop;
        }),
      ),
    );
    expect(failed).toMatchObject({
      driverReset: "failed",
      driverResetError: "socket was not released",
    });
    expect(missing).toMatchObject({ driverReset: "unavailable" });
    expect(idle).toMatchObject({ driverReset: "unavailable" });
    expect(idle!.interruptedThreadIds).toEqual([DESKTOP.threadId]);
  });

  it("interrupts a turn-less action's thread only when its running turn is not newer", async () => {
    const interrupts = await Effect.runPromise(
      Effect.forEach(["2020-01-01T00:00:00.000Z", "2999-01-01T00:00:00.000Z"], (startedAt) =>
        Effect.gen(function* () {
          const { activity, dispatched, state, stop } = yield* setupStop(makeDriver().driver);
          yield* activity.track({ ...DESKTOP, turnId: null }, Effect.void);
          state.threads = [makeThread(DESKTOP.threadId, turnId("d9"), startedAt)];
          yield* stop;
          return interrupted(dispatched);
        }),
      ),
    );
    expect(interrupts).toEqual([[[DESKTOP.threadId, turnId("d9"), 3]], []]);
  });
});
