import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { completeV2Interaction } from "./Runtime.interactions.pending.ts";

/** Publish canonical events once; retain unresolved interaction ownership until sink acceptance. */
export async function emitV2RuntimeEvent(
  session: V2RuntimeSession,
  event: ProviderRuntimeEvent,
  emit: (event: ProviderRuntimeEvent) => Promise<void>,
) {
  if (
    session.stopped &&
    !["turn.aborted", "session.exited", "request.resolved", "user-input.resolved"].includes(
      event.type,
    )
  )
    return;
  if (session.emitted.has(event.eventId)) return;
  if (session.emitted.size >= 20000) throw new Error("V2 canonical event safety bound exceeded.");
  await emit(event);
  session.emitted.add(event.eventId);
  completeV2Interaction(session, event);
}
