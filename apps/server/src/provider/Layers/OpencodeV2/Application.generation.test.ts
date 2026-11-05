import { expect, it, vi } from "vitest";
import { V2GenerationCoordinator } from "./Application.generation.ts";
import { deferred } from "./Test.fixtures.ts";

it("coalesces discovery, fences stale candidates, and recovers again after invalidation", async () => {
  const coordinator = new V2GenerationCoordinator();
  const held = deferred<void>(),
    entered = deferred<void>();
  const publish = vi.fn();
  const discover = vi.fn(async (_signal, validate: () => void) => {
    entered.resolve();
    await held.promise;
    validate();
    publish();
  });
  const first = coordinator.run(discover, () => {});
  const second = coordinator.run(discover, () => {});
  const results = Promise.allSettled([first, second]);
  await entered.promise;
  expect(first).toBe(second);
  coordinator.invalidate();
  held.resolve();
  expect((await results).every((result) => result.status === "rejected")).toBe(true);
  expect(publish).not.toHaveBeenCalled();
  await coordinator.run(
    async (_signal, validate) => {
      validate();
      publish();
    },
    () => {},
  );
  expect(publish).toHaveBeenCalledTimes(1);
  coordinator.close();
  await expect(coordinator.run(discover, () => {})).rejects.toThrow("closed");
});

it("bounds abort-ignoring discovery and backs off instead of spinning", async () => {
  vi.useFakeTimers();
  try {
    const coordinator = new V2GenerationCoordinator();
    const discover = vi.fn(async () => new Promise<void>(() => {}));
    const rejected = expect(coordinator.run(discover, () => {})).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(20001);
    await rejected;
    await expect(coordinator.run(discover, () => {})).rejects.toThrow("backoff");
    expect(discover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1001);
    await coordinator.run(
      async () => {},
      () => {},
    );
    coordinator.close();
  } finally {
    vi.useRealTimers();
  }
});
