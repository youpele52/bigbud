import { afterEach, expect, it, vi } from "vitest";
import { V2OwnerRecovery } from "./Application.recovery.ts";
import { V2GenerationCoordinator } from "./Application.generation.ts";

afterEach(() => vi.useRealTimers());

it("retains immediate errors and exponentially delays only the failing owner", async () => {
  vi.useFakeTimers();
  const owner = {};
  const scheduler = new V2OwnerRecovery<object>();
  const error = new Error("retained history conflict");
  const reconnect = vi.fn(async () => {
    throw error;
  });
  const run = () =>
    scheduler.run(
      [owner],
      new AbortController().signal,
      () => {},
      () => true,
      reconnect,
      () => {},
    );
  await expect(run()).resolves.toEqual([error]);
  await vi.advanceTimersByTimeAsync(999);
  await expect(run()).resolves.toEqual([error]);
  expect(reconnect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await expect(run()).resolves.toEqual([error]);
  await vi.advanceTimersByTimeAsync(1999);
  await expect(run()).resolves.toEqual([error]);
  expect(reconnect).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  await expect(run()).resolves.toEqual([error]);
  expect(reconnect).toHaveBeenCalledTimes(3);
});

it("rotates past four repeatedly slow owners, preserves failures and backs off", async () => {
  vi.useFakeTimers();
  const owners = Array.from({ length: 5 }, (_, id) => ({ id, recovering: true }));
  const scheduler = new V2OwnerRecovery<(typeof owners)[number]>();
  const coordinator = new V2GenerationCoordinator();
  const reconnect = vi.fn(async (owner: (typeof owners)[number], signal: AbortSignal) => {
    if (owner.id === 4) {
      owner.recovering = false;
      return;
    }
    await new Promise<void>((_, reject) =>
      signal.addEventListener("abort", () => reject(new Error("slow")), { once: true }),
    );
  });
  const failed = vi.fn();
  const run = () =>
    coordinator.run(
      async (signal, validate) => {
        await scheduler.run(
          owners,
          signal,
          validate,
          (owner) => owner.recovering,
          reconnect,
          failed,
        );
      },
      () => {},
    );
  for (let round = 0; round < 3; round++) {
    const result = expect(run()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(round === 1 ? 10000 : 15000);
    await result;
  }
  expect(owners[4]!.recovering).toBe(false);
  expect(reconnect.mock.calls.filter(([owner]) => owner.id === 4)).toHaveLength(1);
  expect(failed).toHaveBeenCalledTimes(8);
  coordinator.close();
});

it("does not requeue unresolved physical work and retains its error during retry delay", async () => {
  vi.useFakeTimers();
  const owner = {};
  const scheduler = new V2OwnerRecovery<object>();
  const reconnect = vi.fn(() => new Promise<void>(() => {}));
  const run = () =>
    scheduler.run(
      [owner],
      new AbortController().signal,
      () => {},
      () => true,
      reconnect,
      () => {},
    );
  const first = expect(run()).resolves.toHaveLength(1);
  await vi.advanceTimersByTimeAsync(5000);
  await first;
  await expect(run()).resolves.toHaveLength(1);
  await vi.advanceTimersByTimeAsync(15000);
  await expect(run()).resolves.toHaveLength(1);
  expect(reconnect).toHaveBeenCalledTimes(1);
});
