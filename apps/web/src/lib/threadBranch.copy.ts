import type { NativeApi, ThreadId } from "@bigbud/contracts";
import type { ThreadBranchCopyStatus } from "@bigbud/contracts/orchestration/orchestration.branchCopy.ts";

import { ThreadBranchError } from "./threadBranch";

export const BRANCH_COPY_POLL_MS = 250;
/** Progress shows only once a copy takes noticeably long. */
export const BRANCH_COPY_PROGRESS_DELAY_MS = 600;
/** A copy whose count stops moving this long is reported, though the server keeps trying. */
export const BRANCH_COPY_STALL_MS = 60_000;

type BranchCopyApi = Pick<NativeApi["orchestration"], "getThreadBranchCopy">;

export function formatBranchCopyProgress(status: ThreadBranchCopyStatus): string {
  return `Copying ${status.copiedMessages} of ${status.totalMessages} messages`;
}

/**
 * Follows a server-side branch copy until it completes. Rejects when the copy failed (the
 * server also marks the branch's title), when the server no longer knows the copy, or when it
 * stops making progress. `onProgress` fires after the first poll that is still copying past
 * `BRANCH_COPY_PROGRESS_DELAY_MS`, and on every poll after that.
 */
export async function waitForBranchCopy(input: {
  readonly api: BranchCopyApi;
  readonly branchThreadId: ThreadId;
  readonly initial: ThreadBranchCopyStatus;
  readonly onProgress?: (status: ThreadBranchCopyStatus) => void;
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}): Promise<ThreadBranchCopyStatus> {
  const pollMs = input.pollMs ?? BRANCH_COPY_POLL_MS;
  const sleep = input.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? Date.now;
  const startedAt = now();
  let lastCopied = input.initial.copiedMessages;
  let lastMovedAt = startedAt;
  let status: ThreadBranchCopyStatus | null = input.initial;
  while (status?.state === "copying") {
    if (now() - startedAt >= BRANCH_COPY_PROGRESS_DELAY_MS) input.onProgress?.(status);
    if (now() - lastMovedAt >= BRANCH_COPY_STALL_MS) {
      throw new ThreadBranchError("The branch copy stopped making progress.");
    }
    await sleep(pollMs);
    status = await input.api.getThreadBranchCopy({ branchThreadId: input.branchThreadId });
    if (status && status.copiedMessages !== lastCopied) {
      lastCopied = status.copiedMessages;
      lastMovedAt = now();
    }
  }
  if (status === null) throw new ThreadBranchError("The branch copy was not found.");
  if (status.state === "failed") {
    throw new ThreadBranchError(status.error ?? "The branch copy did not finish.");
  }
  return status;
}
