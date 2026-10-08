import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { invalidateV2Interactions } from "./Runtime.interactions.pending.ts";
import { v2Request } from "./Client.ts";

/** At most two final events plus the already bounded observed interactions, retained by exact owner. */
export function queueV2FinalEvents(session: V2RuntimeSession, events: ProviderRuntimeEvent[]) {
  session.finalEvents ??= [];
  for (const event of events) {
    if (
      session.emitted.has(event.eventId) ||
      session.finalEvents.some((item) => item.eventId === event.eventId)
    )
      continue;
    if (session.finalEvents.length >= 2) throw new Error("V2 final publication bound exceeded.");
    session.finalEvents.push(event);
  }
}

export function needsV2FinalRepair(session: V2RuntimeSession) {
  return Boolean(
    session.lossPending || session.pendingInteractions?.size || session.finalEvents?.length,
  );
}

/** Closure precedes terminal/exit. Sink failure retains the remaining queue, never native execution. */
export async function flushV2FinalEvents(
  session: V2RuntimeSession,
  emit: (owner: V2RuntimeSession, event: ProviderRuntimeEvent) => Promise<void>,
) {
  for (const event of invalidateV2Interactions(session)) await publishFinal(session, event, emit);
  while (session.finalEvents?.length) {
    await publishFinal(session, session.finalEvents[0]!, emit);
    session.finalEvents.shift();
  }
}

/** Observe each raw operation once. After its one deadline, polling inspects state without new waits. */
async function publishFinal(
  session: V2RuntimeSession,
  event: ProviderRuntimeEvent,
  emit: (owner: V2RuntimeSession, event: ProviderRuntimeEvent) => Promise<void>,
) {
  const previous = session.finalPublication;
  if (previous) {
    if (previous.state === "pending") throw new Error("V2 canonical publication remains pending.");
    delete session.finalPublication;
    if (previous.state === "succeeded" && previous.eventId === event.eventId) return;
  }
  const publication = {
    eventId: event.eventId,
    operation: Promise.resolve().then(() => emit(session, event)),
    state: "pending" as "pending" | "succeeded" | "failed",
  };
  session.finalPublication = publication;
  const settled = publication.operation.then(
    () => {
      publication.state = "succeeded";
    },
    () => {
      publication.state = "failed";
    },
  );
  // Exactly one deadline attaches to this settlement signal, never again on polling retries.
  await v2Request("canonical.final.publish", () => settled, { timeoutMs: 1000 });
  if (publication.state === "failed") throw new Error("V2 canonical publication failed.");
  if (session.finalPublication === publication) delete session.finalPublication;
}
