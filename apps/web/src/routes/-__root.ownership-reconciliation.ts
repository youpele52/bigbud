import type { NativeApi, OrchestrationEvent, ThreadId } from "@bigbud/contracts";

import { getDeletedThreadIds } from "../logic/orchestration/thread-deletion.logic";
import { clearAcceptedMaterializationsThrough } from "../stores/materialization/materializationLedger";
import {
  readOwnershipLedger,
  invalidateCanonicalOwnership,
} from "../stores/ownership/ownershipLedger";
import { applyCanonicalOwnership } from "../stores/ownership/ownershipLedger.reconcile";
import type { OwnershipScope } from "../stores/ownership/ownershipLedger.types";

function canonicalThreadEvents(events: ReadonlyArray<OrchestrationEvent>): Map<ThreadId, number> {
  const result = new Map<ThreadId, number>();
  for (const event of events) {
    if (event.type === "thread.created") {
      result.set(event.payload.threadId, event.sequence);
    } else if (event.type === "thread.deleted") {
      for (const threadId of getDeletedThreadIds(event.payload))
        result.set(threadId, event.sequence);
    }
  }
  return result;
}

export async function reconcileAppliedCanonicalOwnership(input: {
  readonly api: Pick<NativeApi, "orchestration">;
  readonly events: ReadonlyArray<OrchestrationEvent>;
  readonly scope?: OwnershipScope | undefined;
}): Promise<void> {
  const canonicalEvents = canonicalThreadEvents(input.events);
  if (canonicalEvents.size === 0) return;
  for (const [threadId, eventSequence] of canonicalEvents) {
    const ownership = await input.api.orchestration.resolveThreadOwnership({ threadId });
    if (ownership.status === "absent") {
      throw new Error(`Canonical ownership was absent after event ${eventSequence}.`);
    }
    if (ownership.status === "unavailable") {
      if (
        ownership.ownership !== "confirmed" ||
        ownership.serverEpoch === undefined ||
        ownership.canonicalRevision === undefined ||
        !input.events.some(
          (event) =>
            event.type === "thread.deleted" &&
            getDeletedThreadIds(event.payload).includes(threadId),
        )
      ) {
        throw new Error("Canonical ownership could not be durably reconciled.");
      }
      await invalidateCanonicalOwnership({
        threadId,
        status: "deleted",
        serverEpoch: ownership.serverEpoch,
        canonicalRevision: ownership.canonicalRevision,
        invalidatedAt: new Date().toISOString(),
      });
      continue;
    }
    await applyCanonicalOwnership(ownership, input.scope ?? "main");
  }

  const ownershipLedger = readOwnershipLedger();
  if (ownershipLedger.status === "unavailable") {
    throw new Error(`Ownership ledger unavailable: ${ownershipLedger.reason}`);
  }
  const appliedSequence = input.events.at(-1)?.sequence;
  if (appliedSequence === undefined) return;
  await clearAcceptedMaterializationsThrough(
    appliedSequence,
    new Set(Object.keys(ownershipLedger.value.invalidationsByThreadId)),
  );
}
