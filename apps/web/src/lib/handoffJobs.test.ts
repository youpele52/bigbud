import { ThreadId } from "@bigbud/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { __resetNativeApiForTests } from "../rpc/nativeApi";
import { HandoffError } from "./handoff";
import { startHandoffJob, waitForHandoffJob } from "./handoffJobs";

describe("handoffJobs", () => {
  beforeEach(() => {
    vi.useRealTimers();
    __resetNativeApiForTests();
  });

  it("waits until the server-side handoff job succeeds without a default timeout", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const getHandoffJob = vi
      .fn()
      .mockResolvedValueOnce({
        jobId: "job-1",
        threadId: "thread-1",
        status: "queued" as const,
        title: "Thread title",
        createdAt: "2026-07-05T10:00:00.000Z",
        updatedAt: "2026-07-05T10:00:00.000Z",
        completedAt: null,
        outputPath: null,
        error: null,
      })
      .mockResolvedValueOnce({
        jobId: "job-1",
        threadId: "thread-1",
        status: "queued" as const,
        title: "Thread title",
        createdAt: "2026-07-05T10:00:00.000Z",
        updatedAt: "2026-07-05T10:02:00.000Z",
        completedAt: null,
        outputPath: null,
        error: null,
      })
      .mockResolvedValueOnce({
        jobId: "job-1",
        threadId: "thread-1",
        status: "succeeded" as const,
        title: "Thread title",
        createdAt: "2026-07-05T10:00:00.000Z",
        updatedAt: "2026-07-05T10:03:00.000Z",
        completedAt: "2026-07-05T10:03:00.000Z",
        outputPath: "/tmp/handoff.md",
        error: null,
      });

    vi.stubGlobal("window", {
      nativeApi: {
        server: {
          getHandoffJob,
        },
      },
      setTimeout,
      clearTimeout,
    });

    const promise = waitForHandoffJob("job-1");
    await vi.advanceTimersByTimeAsync(1_600);

    await expect(promise).resolves.toEqual({
      outputPath: "/tmp/handoff.md",
      title: "Thread title",
    });
    expect(getHandoffJob).toHaveBeenCalledTimes(3);
  });

  it("rejects when an explicit timeout is exceeded", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const getHandoffJob = vi.fn().mockResolvedValue({
      jobId: "job-1",
      threadId: "thread-1",
      status: "running" as const,
      title: "Thread title",
      createdAt: "2026-07-05T10:00:00.000Z",
      updatedAt: "2026-07-05T10:00:30.000Z",
      completedAt: null,
      outputPath: null,
      error: null,
    });

    vi.stubGlobal("window", {
      nativeApi: {
        server: {
          getHandoffJob,
        },
      },
      setTimeout,
      clearTimeout,
    });

    const promise = waitForHandoffJob("job-1", 100);
    const rejection = expect(promise).rejects.toBeInstanceOf(HandoffError);
    await vi.advanceTimersByTimeAsync(800);

    await rejection;
  });

  it("forwards startHandoffJob through the native API", async () => {
    const startHandoffJobRpc = vi.fn().mockResolvedValue({
      jobId: "job-1",
      threadId: "thread-1",
      status: "queued" as const,
      title: "Thread title",
      createdAt: "2026-07-05T10:00:00.000Z",
      updatedAt: "2026-07-05T10:00:00.000Z",
      completedAt: null,
      outputPath: null,
      error: null,
    });

    vi.stubGlobal("window", {
      nativeApi: {
        server: {
          startHandoffJob: startHandoffJobRpc,
        },
      },
    });

    await expect(
      startHandoffJob({
        threadId: ThreadId.makeUnsafe("thread-1"),
        focus: "Continue in a fresh branch",
      }),
    ).resolves.toEqual({
      jobId: "job-1",
      title: "Thread title",
    });
    expect(startHandoffJobRpc).toHaveBeenCalledWith({
      threadId: "thread-1",
      focus: "Continue in a fresh branch",
    });
  });
});
