import type { GetThreadOwnershipResult, NativeApi, ProjectId, ThreadId } from "@bigbud/contracts";

import { createOwnershipReplacementThreadId } from "./useHandleNewThread.ownership";
import {
  clearMaterializationAttempt,
  readMaterializationLedger,
  setMaterializationAttemptStatus,
  type MaterializationAttempt,
} from "../stores/materialization/materializationLedger";

interface ReconcileCallbacks {
  readonly reconcileCanonical: (threadId: ThreadId) => Promise<void> | void;
  readonly replaceCollision: (replacement: {
    threadId: ThreadId;
    nextThreadId: ThreadId;
    projectId: ProjectId;
    createdAt: string;
  }) => void;
}

export interface MaterializationReconciliationSummary {
  readonly accepted: number;
  readonly rejected: number;
  readonly canonical: number;
  readonly pending: number;
}

async function reconcileCanonicalOwnership(
  attempt: MaterializationAttempt,
  ownership: Exclude<GetThreadOwnershipResult, { status: "absent" | "unavailable" }>,
  callbacks: ReconcileCallbacks,
): Promise<void> {
  if (ownership.status === "active") {
    await callbacks.reconcileCanonical(attempt.threadId);
  } else {
    callbacks.replaceCollision({
      threadId: attempt.threadId,
      nextThreadId: await createOwnershipReplacementThreadId(ownership),
      projectId: attempt.projectId,
      createdAt: new Date().toISOString(),
    });
  }
  await clearMaterializationAttempt(attempt.threadId, attempt.generation);
}

export async function reconcilePersistedMaterializationAttempts(input: {
  readonly api: Pick<NativeApi, "orchestration">;
  readonly callbacks: ReconcileCallbacks;
}): Promise<MaterializationReconciliationSummary> {
  const summary = { accepted: 0, rejected: 0, canonical: 0, pending: 0 };
  const ledger = readMaterializationLedger();
  if (ledger.status === "unavailable") return { ...summary, pending: 1 };
  const attempts = Object.values(ledger.value.attemptsByThreadId);

  for (const attempt of attempts) {
    let acceptedOutcomeRecorded = false;
    try {
      const outcome = await input.api.orchestration.getCommandOutcome({
        commandId: attempt.commandId,
      });
      if (outcome.status === "accepted") {
        if (
          outcome.aggregateKind !== attempt.aggregateKind ||
          outcome.aggregateId !== attempt.aggregateId
        ) {
          await setMaterializationAttemptStatus(attempt.threadId, attempt.generation, "ambiguous");
          summary.pending += 1;
          continue;
        }
        await setMaterializationAttemptStatus(
          attempt.threadId,
          attempt.generation,
          "accepted-awaiting-event",
          outcome.resultSequence,
        );
        acceptedOutcomeRecorded = true;
      }

      const ownership = await input.api.orchestration.resolveThreadOwnership({
        threadId: attempt.threadId,
      });
      if (ownership.status === "unavailable") {
        if (outcome.status !== "accepted") {
          await setMaterializationAttemptStatus(attempt.threadId, attempt.generation, "ambiguous");
        }
        summary.pending += 1;
        continue;
      }
      if (ownership.status !== "absent") {
        if (attempt.requiresOutcome && outcome.status !== "accepted") {
          await setMaterializationAttemptStatus(attempt.threadId, attempt.generation, "ambiguous");
          summary.pending += 1;
          continue;
        }
        await reconcileCanonicalOwnership(attempt, ownership, input.callbacks);
        if (outcome.status === "accepted") summary.accepted += 1;
        else summary.canonical += 1;
        continue;
      }
      if (outcome.status === "accepted") {
        summary.pending += 1;
        continue;
      }
      if (outcome.status === "rejected") {
        await clearMaterializationAttempt(attempt.threadId, attempt.generation);
        summary.rejected += 1;
      } else {
        await setMaterializationAttemptStatus(attempt.threadId, attempt.generation, "ambiguous");
        summary.pending += 1;
      }
    } catch {
      if (!acceptedOutcomeRecorded) {
        await setMaterializationAttemptStatus(attempt.threadId, attempt.generation, "ambiguous");
      }
      summary.pending += 1;
    }
  }
  return summary;
}
