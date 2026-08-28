import type {
  CommandId,
  GetThreadOwnershipResult,
  MessageId,
  NativeApi,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts";

import {
  beginMaterializationAttempt,
  clearMaterializationAttempt,
  readMaterializationLedger,
  setMaterializationAttemptStatus,
  type MaterializationAttempt,
} from "../../../stores/materialization/materializationLedger";

export type DraftMaterializationPreflight =
  | { readonly status: "ready"; readonly attempt: MaterializationAttempt }
  | { readonly status: "already-accepted"; readonly attempt: MaterializationAttempt }
  | {
      readonly status: "canonical";
      readonly ownership: Exclude<
        GetThreadOwnershipResult,
        { readonly status: "absent" | "unavailable" }
      >;
    }
  | { readonly status: "blocked"; readonly reason: string };

async function resolveExistingAttempt(
  api: Pick<NativeApi, "orchestration">,
  attempt: MaterializationAttempt,
): Promise<DraftMaterializationPreflight | MaterializationAttempt | null> {
  try {
    const outcome = await api.orchestration.getCommandOutcome({ commandId: attempt.commandId });
    if (outcome.status === "accepted") {
      if (
        outcome.aggregateKind !== attempt.aggregateKind ||
        outcome.aggregateId !== attempt.aggregateId
      ) {
        await setMaterializationAttemptStatus(attempt.threadId, attempt.generation, "ambiguous");
        return {
          status: "blocked",
          reason: "bigbud found a mismatched saved send outcome. Your draft is safe.",
        };
      }
      await setMaterializationAttemptStatus(
        attempt.threadId,
        attempt.generation,
        "accepted-awaiting-event",
        outcome.resultSequence,
      );
      return {
        status: "already-accepted",
        attempt: {
          ...attempt,
          status: "accepted-awaiting-event",
          acceptedSequence: outcome.resultSequence,
        },
      };
    }
    if (outcome.status === "unknown") {
      await setMaterializationAttemptStatus(attempt.threadId, attempt.generation, "ambiguous");
      return { ...attempt, status: "ambiguous" };
    }
    if (
      outcome.aggregateKind !== attempt.aggregateKind ||
      outcome.aggregateId !== attempt.aggregateId
    ) {
      await setMaterializationAttemptStatus(attempt.threadId, attempt.generation, "ambiguous");
      return {
        status: "blocked",
        reason: "bigbud found a mismatched saved send outcome. Your draft is safe.",
      };
    }
    await clearMaterializationAttempt(attempt.threadId, attempt.generation);
    return null;
  } catch {
    await setMaterializationAttemptStatus(attempt.threadId, attempt.generation, "ambiguous");
    return { ...attempt, status: "ambiguous" };
  }
}

export async function prepareDraftMaterialization(input: {
  readonly api: Pick<NativeApi, "orchestration">;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly kind: "turn" | "shell";
  readonly createdAt: string;
  readonly requestDigest: string;
  readonly trackExistingThread?: boolean;
}): Promise<DraftMaterializationPreflight> {
  const ledger = readMaterializationLedger();
  if (ledger.status === "unavailable") {
    return {
      status: "blocked",
      reason: "bigbud cannot safely read saved send state. Your draft is safe.",
    };
  }
  const existing = ledger.value.attemptsByThreadId[input.threadId];
  let retryAttempt: MaterializationAttempt | null = null;
  if (existing) {
    const resolution = await resolveExistingAttempt(input.api, existing);
    if (resolution && "threadId" in resolution) retryAttempt = resolution;
    else if (resolution) return resolution;
  }

  let ownership: GetThreadOwnershipResult;
  try {
    ownership = await input.api.orchestration.resolveThreadOwnership({ threadId: input.threadId });
  } catch {
    return { status: "blocked", reason: "bigbud is not connected to the server." };
  }
  if (ownership.status === "unavailable") {
    return { status: "blocked", reason: ownership.reason };
  }
  if (ownership.status !== "absent" && !input.trackExistingThread) {
    return { status: "canonical", ownership };
  }

  if (retryAttempt) {
    if (retryAttempt.requestDigest !== input.requestDigest) {
      return {
        status: "blocked",
        reason:
          "Your previous send is still being checked. Its draft is safe and cannot be replaced yet.",
      };
    }
    await setMaterializationAttemptStatus(
      retryAttempt.threadId,
      retryAttempt.generation,
      "prepared",
    );
    return { status: "ready", attempt: { ...retryAttempt, status: "prepared" } };
  }

  return {
    status: "ready",
    attempt: await beginMaterializationAttempt({
      threadId: input.threadId,
      projectId: input.projectId,
      aggregateKind: "thread",
      aggregateId: input.threadId,
      commandId: input.commandId,
      messageId: input.messageId,
      kind: input.kind,
      createdAt: input.createdAt,
      requestDigest: input.requestDigest,
      serverEpoch: ownership.serverEpoch,
      ownershipRevision: ownership.canonicalRevision,
      ...(input.trackExistingThread ? { requiresOutcome: true } : {}),
    }),
  };
}

export async function resolveFailedMaterialization(input: {
  readonly api: Pick<NativeApi, "orchestration">;
  readonly attempt: MaterializationAttempt;
}): Promise<"accepted" | "rejected" | "ambiguous"> {
  try {
    const outcome = await input.api.orchestration.getCommandOutcome({
      commandId: input.attempt.commandId,
    });
    if (outcome.status === "accepted") {
      if (
        outcome.aggregateKind !== input.attempt.aggregateKind ||
        outcome.aggregateId !== input.attempt.aggregateId
      ) {
        await setMaterializationAttemptStatus(
          input.attempt.threadId,
          input.attempt.generation,
          "ambiguous",
        );
        return "ambiguous";
      }
      await setMaterializationAttemptStatus(
        input.attempt.threadId,
        input.attempt.generation,
        "accepted-awaiting-event",
        outcome.resultSequence,
      );
      return "accepted";
    }
    if (outcome.status === "rejected") {
      if (
        outcome.aggregateKind !== input.attempt.aggregateKind ||
        outcome.aggregateId !== input.attempt.aggregateId
      ) {
        await setMaterializationAttemptStatus(
          input.attempt.threadId,
          input.attempt.generation,
          "ambiguous",
        );
        return "ambiguous";
      }
      await clearMaterializationAttempt(input.attempt.threadId, input.attempt.generation);
      return "rejected";
    }
  } catch {
    // The durable result remains unknown; preserve the attempt for restart reconciliation.
  }
  await setMaterializationAttemptStatus(
    input.attempt.threadId,
    input.attempt.generation,
    "ambiguous",
  );
  return "ambiguous";
}
