import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import {
  MobileGatewayProcessError,
  settledMobileGatewayProcess,
} from "./mobileGatewayProcess.lifetime";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe("owned mobile gateway interruption", () => {
  it("waits for real cleanup and reports uncertain exit after interruption", async () => {
    const started = deferred(),
      aborted = deferred(),
      cleanup = deferred();
    const fiber = Effect.runFork(
      settledMobileGatewayProcess(async (signal) => {
        signal.addEventListener("abort", aborted.resolve, { once: true });
        started.resolve();
        await cleanup.promise;
        throw new MobileGatewayProcessError({
          message: "Exact child exit is unknown.",
          repairRequired: true,
        });
      }),
    );
    await started.promise;
    let settled = false;
    const interrupted = Effect.runPromise(
      Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))),
    ).then((exit) => {
      settled = true;
      return exit;
    });
    await aborted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    cleanup.resolve();
    const exit = await interrupted;
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") throw Error("Expected interruption failure.");
    expect(Cause.pretty(exit.cause)).toContain("Exact child exit is unknown.");
  });

  it("settles confirmed cleanup before preserving normal interruption", async () => {
    const started = deferred(),
      aborted = deferred(),
      cleanup = deferred();
    const fiber = Effect.runFork(
      settledMobileGatewayProcess(async (signal) => {
        signal.addEventListener("abort", aborted.resolve, { once: true });
        started.resolve();
        await cleanup.promise;
      }),
    );
    await started.promise;
    const interrupted = Effect.runPromise(
      Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))),
    );
    await aborted.promise;
    cleanup.resolve();
    const exit = await interrupted;
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") throw Error("Expected interruption failure.");
    expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(Cause.pretty(exit.cause)).not.toContain("repairRequired");
  });
});
