import { derivePendingApprovals, type PendingApproval } from "../logic/session";
import type { Thread } from "../models/types";

export interface PendingApprovalNavigationCandidate {
  threadId: Thread["id"];
  approval: PendingApproval;
}

export function collectLatestPendingApprovalCandidate(
  threads: ReadonlyArray<Thread>,
): PendingApprovalNavigationCandidate | null {
  let candidate: PendingApprovalNavigationCandidate | null = null;

  for (const thread of threads) {
    const approval = derivePendingApprovals(thread.activities)[0] ?? null;
    if (!approval) {
      continue;
    }
    if (!candidate || approval.createdAt > candidate.approval.createdAt) {
      candidate = {
        threadId: thread.id,
        approval,
      };
    }
  }

  return candidate;
}
