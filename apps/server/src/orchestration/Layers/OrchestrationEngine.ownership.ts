import type {
  GetThreadOwnershipResult,
  OrchestrationReadModel,
  OrchestrationThread,
  ThreadId,
} from "@bigbud/contracts";
import { Effect, Option, type Semaphore } from "effect";

import type { OrchestrationEventStoreShape } from "../../persistence/Services/OrchestrationEventStore.ts";

function lifecycleStatus(
  thread: OrchestrationThread,
): "active" | "archived" | "deleting" | "deleted" {
  if (thread.deletedAt !== null) return "deleted";
  if (thread.deletingAt !== null) return "deleting";
  if (thread.archivedAt !== null) return "archived";
  return "active";
}

export function makeThreadOwnershipResolver<HydrationError>(input: {
  serverEpoch: string;
  commandSemaphore: Semaphore.Semaphore;
  eventStore: Pick<OrchestrationEventStoreShape, "findThreadOwnershipEvidence">;
  readModel: () => OrchestrationReadModel;
  hydrate:
    | ((threadId: ThreadId) => Effect.Effect<OrchestrationThread | undefined, HydrationError>)
    | null;
}) {
  return (threadId: ThreadId): Effect.Effect<GetThreadOwnershipResult> =>
    input.commandSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const evidence = yield* input.eventStore.findThreadOwnershipEvidence(threadId);
        const revision = input.readModel().snapshotSequence;
        if (Option.isNone(evidence)) {
          return {
            threadId,
            status: "absent" as const,
            serverEpoch: input.serverEpoch,
            canonicalRevision: revision,
            reusePolicy: "canonical-identity-unclaimed" as const,
          };
        }

        const current = input.readModel().threads.find((thread) => thread.id === threadId);
        const thread = current ?? (input.hydrate ? yield* input.hydrate(threadId) : undefined);
        const canonicalRevision = input.readModel().snapshotSequence;
        if (!thread) {
          if (evidence.value.projectId === null || evidence.value.latestCreatedSequence === null) {
            return {
              threadId,
              status: "unavailable" as const,
              ownership: "confirmed" as const,
              reason: "Canonical deletion is confirmed, but project ownership is unavailable.",
              serverEpoch: input.serverEpoch,
              canonicalRevision: Math.max(
                canonicalRevision,
                evidence.value.deletionSequence ?? canonicalRevision,
              ),
            };
          }
          if (
            evidence.value.deletionSequence !== null &&
            evidence.value.deletionSequence > evidence.value.latestCreatedSequence
          ) {
            return {
              threadId,
              projectId: evidence.value.projectId,
              status: "deleted" as const,
              reusePolicy: "explicit-create-after-deletion" as const,
              serverEpoch: input.serverEpoch,
              canonicalRevision: Math.max(canonicalRevision, evidence.value.deletionSequence),
            };
          }
          return {
            threadId,
            projectId: evidence.value.projectId,
            status: "unavailable" as const,
            ownership: "confirmed" as const,
            reason: "Canonical ownership is confirmed, but lifecycle state is unavailable.",
            serverEpoch: input.serverEpoch,
            canonicalRevision,
          };
        }
        if (evidence.value.projectId === null) {
          return {
            threadId,
            status: "unavailable" as const,
            ownership: "confirmed" as const,
            reason: "Canonical ownership is confirmed, but project ownership is unavailable.",
            serverEpoch: input.serverEpoch,
            canonicalRevision,
          };
        }
        const status = lifecycleStatus(thread);
        if (status === "deleted") {
          return {
            threadId,
            projectId: evidence.value.projectId,
            status,
            reusePolicy: "explicit-create-after-deletion" as const,
            serverEpoch: input.serverEpoch,
            canonicalRevision,
          };
        }
        return {
          threadId,
          projectId: evidence.value.projectId,
          status,
          serverEpoch: input.serverEpoch,
          canonicalRevision,
        };
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("thread ownership resolution failed", {
            threadId,
            error: error instanceof Error ? error.message : String(error),
          }).pipe(
            Effect.as({
              threadId,
              status: "unavailable" as const,
              ownership: "unconfirmed" as const,
              reason: "Canonical ownership could not be confirmed.",
              serverEpoch: input.serverEpoch,
              canonicalRevision: input.readModel().snapshotSequence,
            }),
          ),
        ),
      ),
    );
}
