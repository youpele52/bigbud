import { afterEach, expect, it, vi } from "vitest";
import {
  createSubscriptionRefreshCoordinator,
  SUBSCRIPTION_REFRESH_INTERVAL_MS as interval,
} from "./UsageSubscriptionLimits.polling";

afterEach(() => vi.useRealTimers());

it("runs one due refresh for two viewers, stops with no viewers, and catches up on reopening", async () => {
  vi.useFakeTimers();
  const read = vi.fn(async () => undefined);
  const coordinator = createSubscriptionRefreshCoordinator(read);
  const closePage = coordinator.watch();
  const closePanel = coordinator.watch();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(1);
  closePage();
  await vi.advanceTimersByTimeAsync(interval);
  expect(read).toHaveBeenCalledTimes(2);
  closePanel();
  await vi.advanceTimersByTimeAsync(interval);
  expect(read).toHaveBeenCalledTimes(2);
  const reopen = coordinator.watch();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(3);
  reopen();
});

it("joins manual and automatic requests and schedules another attempt after failure", async () => {
  vi.useFakeTimers();
  const read = vi.fn(async () => undefined).mockRejectedValueOnce(new Error("offline"));
  const coordinator = createSubscriptionRefreshCoordinator(read);
  const close = coordinator.watch();
  await expect(coordinator.refresh()).rejects.toThrow("offline");
  expect(read).toHaveBeenCalledTimes(1);
  close();
  await vi.advanceTimersByTimeAsync(interval - 1);
  const reopen = coordinator.watch();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(2);
  reopen();
});
