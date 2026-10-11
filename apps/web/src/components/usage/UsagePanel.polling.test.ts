import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUsagePanelPoller, USAGE_PANEL_REFRESH_MS } from "./UsagePanel.polling";
import { requestUsagePanelSummary } from "./UsagePanel.request";
import type { ServerUsageSummaryResult } from "@bigbud/contracts/server/usage.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("Usage panel polling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("requests immediately on open, refreshes every 60s, and stops when closed", async () => {
    const fetchSummary = vi.fn().mockResolvedValue("summary");
    const onSuccess = vi.fn();
    const poller = createUsagePanelPoller({
      fetchSummary,
      onSuccess,
      onStart: vi.fn(),
      onError: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchSummary).not.toHaveBeenCalled();
    poller.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(onSuccess).toHaveBeenCalledWith("summary");
    await vi.advanceTimersByTimeAsync(USAGE_PANEL_REFRESH_MS - 1);
    expect(fetchSummary).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSummary).toHaveBeenCalledTimes(2);
    poller.setEnabled(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchSummary).toHaveBeenCalledTimes(2);
    poller.setEnabled(true);
    expect(fetchSummary).toHaveBeenCalledTimes(3);
    poller.setEnabled(false);
  });

  it("never overlaps and rejects an old visibility epoch even after reopening", async () => {
    const old = deferred<string>();
    const current = deferred<string>();
    const fetchSummary = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const onSuccess = vi.fn();
    const poller = createUsagePanelPoller({
      fetchSummary,
      onSuccess,
      onStart: vi.fn(),
      onError: vi.fn(),
    });
    poller.setEnabled(true);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fetchSummary).toHaveBeenCalledTimes(1);
    poller.setEnabled(false);
    poller.setEnabled(true);
    expect(fetchSummary).toHaveBeenCalledTimes(1);
    old.resolve("old");
    await vi.advanceTimersByTimeAsync(0);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(fetchSummary).toHaveBeenCalledTimes(2);
    current.resolve("current");
    await vi.advanceTimersByTimeAsync(0);
    expect(onSuccess).toHaveBeenCalledExactlyOnceWith("current");
    poller.setEnabled(false);
  });

  it("ignores failures after close and reports active failures once per request without clearing data", async () => {
    const pending = deferred<string>();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const fetchSummary = vi
      .fn()
      .mockResolvedValueOnce("retained")
      .mockReturnValueOnce(pending.promise)
      .mockRejectedValue(new Error("offline"));
    const poller = createUsagePanelPoller({ fetchSummary, onSuccess, onStart: vi.fn(), onError });
    poller.setEnabled(true);
    await vi.advanceTimersByTimeAsync(60_000);
    poller.setEnabled(false);
    pending.reject(new Error("old error"));
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).not.toHaveBeenCalled();
    poller.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledExactlyOnceWith("retained");
    poller.setEnabled(false);
  });

  it("serializes across unmount/reopen and skips queued closed-tab requests", async () => {
    const old = deferred<ServerUsageSummaryResult>();
    const current = { streakDays: 11 } as ServerUsageSummaryResult;
    const server = {
      getUsageSummary: vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(current),
    };
    const makePoller = () => {
      const onSuccess = vi.fn();
      const onError = vi.fn();
      return {
        onSuccess,
        onError,
        poller: createUsagePanelPoller({
          fetchSummary: (isCurrent) => requestUsagePanelSummary(server, isCurrent),
          onStart: vi.fn(),
          onSuccess,
          onError,
        }),
      };
    };
    const first = makePoller();
    first.poller.setEnabled(true);
    first.poller.setEnabled(false);
    const closed = makePoller();
    closed.poller.setEnabled(true);
    closed.poller.setEnabled(false);
    const reopened = makePoller();
    reopened.poller.setEnabled(true);
    expect(server.getUsageSummary).toHaveBeenCalledTimes(1);
    old.resolve({ streakDays: 1 } as ServerUsageSummaryResult);
    await vi.advanceTimersByTimeAsync(0);
    expect(first.onSuccess).not.toHaveBeenCalled();
    expect(closed.onSuccess).not.toHaveBeenCalled();
    expect(closed.onError).not.toHaveBeenCalled();
    expect(server.getUsageSummary).toHaveBeenCalledTimes(2);
    expect(reopened.onSuccess).toHaveBeenCalledExactlyOnceWith(current);
    reopened.poller.setEnabled(false);
  });
});
