import type { NativeApi, ProjectId, ThreadId } from "@bigbud/contracts";

import type { ProjectDraftThread } from "../stores/composer";
import { createOwnershipReplacementThreadId } from "./useHandleNewThread.ownership";

export const DRAFT_OWNERSHIP_REPAIR_CONCURRENCY = 4;

export interface DraftOwnershipRepairSummary {
  readonly absent: number;
  readonly canonical: number;
  readonly replaced: number;
  readonly unavailable: number;
  readonly failures: ReadonlyArray<DraftOwnershipRepairFailure>;
}

export interface DraftOwnershipRepairFailure {
  readonly threadId: ThreadId;
  readonly reason: "ownership_unavailable" | "request_failed";
}

export async function repairPersistedDraftOwnership(input: {
  readonly api: Pick<NativeApi, "orchestration">;
  readonly drafts: ReadonlyArray<ProjectDraftThread>;
  readonly reconcileCanonical: (threadId: ThreadId) => void;
  readonly replaceCollision: (replacement: {
    threadId: ThreadId;
    nextThreadId: ThreadId;
    projectId: ProjectId;
    createdAt: string;
  }) => void;
  readonly createReplacementThreadId?: typeof createOwnershipReplacementThreadId;
}): Promise<DraftOwnershipRepairSummary> {
  const summary: {
    absent: number;
    canonical: number;
    replaced: number;
    unavailable: number;
    failures: DraftOwnershipRepairFailure[];
  } = { absent: 0, canonical: 0, replaced: 0, unavailable: 0, failures: [] };
  let cursor = 0;
  const createReplacementThreadId =
    input.createReplacementThreadId ?? createOwnershipReplacementThreadId;

  const worker = async () => {
    while (cursor < input.drafts.length) {
      const draft = input.drafts[cursor++];
      if (!draft) return;
      try {
        const ownership = await input.api.orchestration.resolveThreadOwnership({
          threadId: draft.threadId,
        });
        if (ownership.status === "absent") {
          summary.absent += 1;
          continue;
        }
        if (ownership.status === "unavailable") {
          summary.unavailable += 1;
          summary.failures.push({
            threadId: draft.threadId,
            reason: "ownership_unavailable",
          });
          continue;
        }
        if (ownership.status === "active") {
          input.reconcileCanonical(draft.threadId);
          summary.canonical += 1;
          continue;
        }
        input.replaceCollision({
          threadId: draft.threadId,
          nextThreadId: await createReplacementThreadId(ownership),
          projectId: draft.projectId,
          createdAt: new Date().toISOString(),
        });
        summary.replaced += 1;
      } catch {
        summary.unavailable += 1;
        summary.failures.push({ threadId: draft.threadId, reason: "request_failed" });
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(DRAFT_OWNERSHIP_REPAIR_CONCURRENCY, input.drafts.length) },
      worker,
    ),
  );
  return summary;
}
