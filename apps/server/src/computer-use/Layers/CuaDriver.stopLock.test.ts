import { Effect, Exit, Fiber } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeComputerUseStop } from "../computerUseStop.ts";
import { makeFakeEngine, makeThread, threadId, turnId } from "../computerUseStop.testSupport.ts";
import { executeDesktopSession } from "./ComputerUse.desktop.session.ts";
import { makeComputerUseActivity } from "./ComputerUseActivity.ts";
import { makeCuaDriver } from "./CuaDriver.ts";
import { installFakeCuaDriver } from "./CuaDriver.fake.testSupport.ts";

const TYPING = { threadId: threadId("typing"), turnId: turnId("t1"), surface: "desktop" as const };
const WAITING = {
  threadId: threadId("waiting"),
  turnId: turnId("w1"),
  surface: "desktop" as const,
};

let fake: ReturnType<typeof installFakeCuaDriver>;

describe("Stop and the desktop exclusive lock", () => {
  beforeEach(() => {
    fake = installFakeCuaDriver("list_windows");
  });

  afterEach(() => fake.restore());

  it("never lets an action that waited on the lock through a Stop reach the driver", async () => {
    const driver = makeCuaDriver();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const activity = yield* makeComputerUseActivity;
        const { engine } = makeFakeEngine([
          makeThread(TYPING.threadId, TYPING.turnId),
          makeThread(WAITING.threadId, WAITING.turnId),
        ]);
        const stop = makeComputerUseStop({ activity, engine, driver });
        const run = (key: typeof TYPING, action: "list_windows" | "list_apps") =>
          Effect.forkChild(
            Effect.exit(
              activity.track(key, executeDesktopSession(key.threadId, driver, { action })),
            ),
          );
        // The first action holds the lock with a call the driver never answers.
        const holder = yield* run(TYPING, "list_windows");
        yield* Effect.promise(() => fake.waitForCall("list_windows"));
        // The second, from another thread, waits for the lock.
        const waiter = yield* run(WAITING, "list_apps");
        yield* Effect.sleep("50 millis");

        const stopped = yield* stop;
        const exits = [yield* Fiber.join(holder), yield* Fiber.join(waiter)];
        const callsAtStop = fake.calls();
        // A turn admitted after the Stop works normally again.
        const later = yield* activity.track(
          { ...WAITING, turnId: turnId("w2") },
          executeDesktopSession(WAITING.threadId, driver, { action: "list_apps" }),
        );
        return { stopped, exits, callsAtStop, later, callsAfter: fake.calls() };
      }),
    );
    await Effect.runPromise(driver.dispose);

    expect(result.stopped.interruptedThreadIds.toSorted()).toEqual(
      [TYPING.threadId, WAITING.threadId].toSorted(),
    );
    for (const exit of result.exits) {
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain("stopped by the user");
    }
    expect(result.callsAtStop).toEqual(["start_session", "list_windows"]);
    expect(result.later.summary).toBe("Listed desktop apps.");
    expect(result.callsAfter.slice(2)).toEqual(["start_session", "list_apps", "end_session"]);
  }, 20_000);
});
