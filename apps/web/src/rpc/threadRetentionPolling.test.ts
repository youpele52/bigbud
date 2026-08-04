import { describe, expect, it, vi } from "vitest";

import {
  getThreadRetentionPollRetryDelayMs,
  getThreadRetentionRunWithRetry,
} from "./threadRetentionPolling";

const RUN = {
  runId: "run-1",
  trigger: "manual",
  policy: "7-days",
  cutoffAt: "2026-07-28T00:00:00.000Z",
  status: "queued",
  eligibleCount: 2,
  selectedCount: 0,
  requestedCount: 0,
  completedCount: 0,
  skippedCount: 0,
  failedCount: 0,
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z",
  completedAt: null,
  deferredReason: null,
  errorMessage: null,
} as const;

describe("threadRetentionPolling", () => {
  it("retries transient polling failures with bounded exponential backoff", async () => {
    const getRun = vi
      .fn()
      .mockRejectedValueOnce(new Error("SocketCloseError: 1006"))
      .mockRejectedValueOnce(new Error("ping timeout"))
      .mockResolvedValue(RUN);
    const sleep = vi.fn(async () => undefined);

    await expect(
      getThreadRetentionRunWithRetry(getRun, { runId: RUN.runId }, { sleep }),
    ).resolves.toEqual(RUN);
    expect(sleep.mock.calls).toEqual([
      [500, undefined],
      [1_000, undefined],
    ]);
    expect(getThreadRetentionPollRetryDelayMs(20)).toBe(4_000);
  });

  it("does not retry actionable server failures", async () => {
    const getRun = vi.fn().mockRejectedValue(new Error("Retention run was not found."));
    const sleep = vi.fn(async () => undefined);

    await expect(
      getThreadRetentionRunWithRetry(getRun, { runId: RUN.runId }, { sleep }),
    ).rejects.toThrow("Retention run was not found.");
    expect(getRun).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("exhausts the configured retries before surfacing a transient failure", async () => {
    const getRun = vi.fn().mockRejectedValue(new Error("SocketCloseError: 1006"));
    const sleep = vi.fn(async () => undefined);

    await expect(
      getThreadRetentionRunWithRetry(getRun, { runId: RUN.runId }, { maxRetries: 2, sleep }),
    ).rejects.toThrow("SocketCloseError: 1006");
    expect(getRun).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("aborts and clears pending retry work", async () => {
    const controller = new AbortController();
    const getRun = vi.fn().mockRejectedValue(new Error("SocketCloseError: 1006"));
    const sleep = vi.fn(async (_delayMs: number, signal?: AbortSignal) => {
      controller.abort();
      signal?.throwIfAborted();
    });

    await expect(
      getThreadRetentionRunWithRetry(
        getRun,
        { runId: RUN.runId },
        {
          signal: controller.signal,
          sleep,
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(getRun).toHaveBeenCalledOnce();
  });
});
