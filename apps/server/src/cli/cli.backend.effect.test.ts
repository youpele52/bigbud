import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect, it } from "vitest";
import { backendCliOwned } from "./cli.backend.effect.ts";

it("settles accepted cancellation cleanup before releasing the CLI fiber", async () => {
  let started!: () => void, finish!: () => void;
  const accepted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const cleanup = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let aborted = false,
    settled = false;
  const fiber = Effect.runFork(
    backendCliOwned(async (signal) => {
      started();
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
      await cleanup;
      settled = true;
    }),
  );
  await accepted;
  let joined = false;
  const interrupted = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
    joined = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(aborted).toBe(true);
  expect(joined).toBe(false);
  expect(settled).toBe(false);
  finish();
  await interrupted;
  expect(settled).toBe(true);
  expect(joined).toBe(true);
});
