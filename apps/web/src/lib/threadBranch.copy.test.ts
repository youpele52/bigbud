import { ThreadId } from "@bigbud/contracts";
import type { ThreadBranchCopyStatus } from "@bigbud/contracts/orchestration/orchestration.branchCopy.ts";
import { describe, expect, it, vi } from "vitest";

import {
  BRANCH_COPY_PROGRESS_DELAY_MS,
  BRANCH_COPY_STALL_MS,
  formatBranchCopyProgress,
  waitForBranchCopy,
} from "./threadBranch.copy";
import { ThreadBranchError } from "./threadBranch";

const branchThreadId = ThreadId.makeUnsafe("branch");
const status = (
  state: ThreadBranchCopyStatus["state"],
  copiedMessages: number,
  error: string | null = null,
): ThreadBranchCopyStatus => ({
  branchThreadId,
  state,
  copiedMessages,
  totalMessages: 300,
  error,
});

/** A fake clock that advances by `pollMs` on every sleep. */
function clock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}

describe("waitForBranchCopy", () => {
  it("reports progress once the copy takes noticeable time and resolves when it completes", async () => {
    const polls = [status("copying", 100), status("copying", 200), status("completed", 300)];
    const getThreadBranchCopy = vi.fn(async () => polls.shift() ?? null);
    const onProgress = vi.fn();
    const time = clock();

    const done = await waitForBranchCopy({
      api: { getThreadBranchCopy },
      branchThreadId,
      initial: status("copying", 0),
      onProgress,
      pollMs: BRANCH_COPY_PROGRESS_DELAY_MS / 2,
      ...time,
    });

    expect(done.copiedMessages).toBe(300);
    expect(onProgress.mock.calls.map(([entry]) => formatBranchCopyProgress(entry))).toEqual([
      "Copying 200 of 300 messages",
    ]);
  });

  it("rejects with the server's reason when the copy failed", async () => {
    const getThreadBranchCopy = vi.fn(async () =>
      status("failed", 25, "The source thread was deleted before the copy finished."),
    );
    await expect(
      waitForBranchCopy({
        api: { getThreadBranchCopy },
        branchThreadId,
        initial: status("copying", 0),
        ...clock(),
      }),
    ).rejects.toThrow("deleted before the copy finished");
  });

  it("gives up on a copy that stops making progress", async () => {
    const getThreadBranchCopy = vi.fn(async () => status("copying", 10));
    await expect(
      waitForBranchCopy({
        api: { getThreadBranchCopy },
        branchThreadId,
        initial: status("copying", 10),
        pollMs: BRANCH_COPY_STALL_MS / 4,
        ...clock(),
      }),
    ).rejects.toBeInstanceOf(ThreadBranchError);
  });
});
