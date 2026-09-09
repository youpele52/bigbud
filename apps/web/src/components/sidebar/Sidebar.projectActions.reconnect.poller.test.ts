import { afterEach, describe, expect, it, vi } from "vitest";
import { createReconnectPoller } from "./Sidebar.projectActions.reconnect.poller";

const request = { requestId: "persisted-request" };
afterEach(() => vi.useRealTimers());

describe("reconnect status recovery", () => {
  it("retries a transient failure using the same request until the operation finishes", async () => {
    vi.useFakeTimers();
    const check = vi
      .fn()
      .mockRejectedValueOnce(new Error("Disconnected"))
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const poller = createReconnectPoller(check);
    await poller.reconcile(request);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(check.mock.calls).toEqual([[request], [request], [request]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("backs off repeated failures and cancels recovery on unmount", async () => {
    vi.useFakeTimers();
    const check = vi.fn().mockRejectedValue(new Error("Unavailable"));
    const poller = createReconnectPoller(check);
    await poller.reconcile(request);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(3);
    poller.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("does not overlap status queries or reschedule a stopped in-flight query", async () => {
    vi.useFakeTimers();
    let resolve!: (active: boolean) => void;
    const check = vi.fn(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    const poller = createReconnectPoller(check);
    const first = poller.reconcile(request);
    await poller.reconcile(request);
    expect(check).toHaveBeenCalledTimes(1);
    poller.stop();
    resolve(true);
    await first;
    expect(vi.getTimerCount()).toBe(0);
    poller.resume();
    const resumed = poller.reconcile(request);
    resolve(false);
    await resumed;
    expect(check).toHaveBeenCalledTimes(2);
  });
});
