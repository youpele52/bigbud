import { afterEach, expect, it, vi } from "vitest";
import { makeRemotePtyRestartBarrier } from "./remoteAgentOwnedPty.restart";

afterEach(() => vi.useRealTimers());

it("graceful verified settlement cancels escalation", async () => {
  vi.useFakeTimers();
  const force = vi.fn(async () => {});
  const barrier = makeRemotePtyRestartBarrier(async () => {}, force);
  const close = barrier.prepareRestart();
  barrier.recordExit(true, Promise.resolve());
  await close;
  await vi.advanceTimersByTimeAsync(2000);
  expect(force).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("acknowledged escalation without exit stays fenced across timeout and retry", async () => {
  vi.useFakeTimers();
  const graceful = vi.fn(async () => {});
  const force = vi.fn(async () => {});
  const barrier = makeRemotePtyRestartBarrier(graceful, force);
  const first = expect(barrier.prepareRestart()).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(1500);
  expect(force).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(8500);
  await first;
  let complete = false;
  const retry = barrier.prepareRestart().then(() => {
    complete = true;
  });
  expect(complete).toBe(false);
  barrier.recordExit(true, Promise.resolve());
  await retry;
  expect(graceful).toHaveBeenCalledOnce();
  expect(force).toHaveBeenCalledOnce();
});

it("failed escalation refuses success; an uncertain exit cannot release the fence", async () => {
  vi.useFakeTimers();
  const barrier = makeRemotePtyRestartBarrier(
    async () => {},
    async () => {
      throw new Error("signal rejected");
    },
  );
  const outcome = expect(barrier.prepareRestart()).rejects.toThrow("signal rejected");
  await vi.advanceTimersByTimeAsync(1500);
  await outcome;
  barrier.recordExit(false, Promise.resolve());
  await expect(barrier.prepareRestart()).rejects.toThrow("exit is uncertain");
  expect(vi.getTimerCount()).toBe(0);
});

it("starts escalation without a close ACK and settles from verified durable exit", async () => {
  vi.useFakeTimers();
  let rejectClose!: (error: Error) => void;
  let rejectForce!: (error: Error) => void;
  let persist!: () => void;
  const force = vi.fn(
    () =>
      new Promise<void>((_, reject) => {
        rejectForce = reject;
      }),
  );
  const barrier = makeRemotePtyRestartBarrier(
    () =>
      new Promise<void>((_, reject) => {
        rejectClose = reject;
      }),
    force,
  );
  let complete = false;
  const closing = barrier.prepareRestart().then(() => {
    complete = true;
  });
  await vi.advanceTimersByTimeAsync(1500);
  expect(force).toHaveBeenCalledOnce();
  barrier.recordExit(
    true,
    new Promise<void>((resolve) => {
      persist = resolve;
    }),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(complete).toBe(false);
  persist();
  await closing;
  // Late failures belong to requests already superseded by definitive evidence.
  rejectClose(new Error("late close ACK failure"));
  rejectForce(new Error("late signal ACK failure"));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(complete).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("durable graceful exit wins over a lost close ACK and cancels escalation", async () => {
  vi.useFakeTimers();
  const force = vi.fn(async () => {});
  const barrier = makeRemotePtyRestartBarrier(() => new Promise<void>(() => {}), force);
  const closing = barrier.prepareRestart();
  barrier.recordExit(true, Promise.resolve());
  await closing;
  await vi.advanceTimersByTimeAsync(2000);
  expect(force).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("a lost signal ACK does not release uncertain or failed durable ownership", async () => {
  vi.useFakeTimers();
  const barrier = makeRemotePtyRestartBarrier(
    async () => {},
    () => new Promise<void>(() => {}),
  );
  const closing = expect(barrier.prepareRestart()).rejects.toThrow("persist failed");
  await vi.advanceTimersByTimeAsync(1500);
  barrier.recordExit(true, Promise.reject(new Error("persist failed")));
  await closing;
  expect(vi.getTimerCount()).toBe(0);
});
