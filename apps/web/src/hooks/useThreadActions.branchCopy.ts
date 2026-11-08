import type { NativeApi } from "@bigbud/contracts";
import type { StartThreadBranchInput } from "@bigbud/contracts/orchestration/orchestration.branchCopy.ts";

import { toastManager } from "../components/ui/toast";
import { formatBranchCopyProgress, waitForBranchCopy } from "../lib/threadBranch.copy";

/**
 * Starts a server-side branch and waits for its copy. A copy that takes noticeable time shows a
 * blue progress toast, closed when the copy ends either way. Resolves with the number of copied
 * messages; rejects when the copy failed.
 */
export async function runServerBranchCopy(input: {
  readonly api: NativeApi;
  readonly branch: StartThreadBranchInput;
}): Promise<number> {
  const initial = await input.api.orchestration.startThreadBranch(input.branch);
  let toastId: ReturnType<typeof toastManager.add> | null = null;
  try {
    const done = await waitForBranchCopy({
      api: input.api.orchestration,
      branchThreadId: input.branch.branchThreadId,
      initial,
      onProgress: (status) => {
        const toast = {
          type: "loading" as const,
          title: "Branching thread",
          description: formatBranchCopyProgress(status),
        };
        if (toastId === null) toastId = toastManager.add(toast);
        else toastManager.update(toastId, toast);
      },
    });
    return done.copiedMessages;
  } finally {
    if (toastId !== null) toastManager.close(toastId);
  }
}
