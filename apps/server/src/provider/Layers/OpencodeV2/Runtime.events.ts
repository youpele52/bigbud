import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { completeV2Interaction } from "./Runtime.interactions.pending.ts";
import { currentV2RequestContext } from "./Client.guard.ts";

/** Publish canonical events once; retain unresolved interaction ownership until sink acceptance. */
export async function emitV2RuntimeEvent(
  session: V2RuntimeSession,
  event: ProviderRuntimeEvent,
  emit: (event: ProviderRuntimeEvent, validate?: () => void) => Promise<void>,
  validate?: () => void,
) {
  if (
    session.stopped &&
    !["turn.aborted", "session.exited", "request.resolved", "user-input.resolved"].includes(
      event.type,
    )
  )
    return;
  if (session.emitted.has(event.eventId)) return;
  const context = currentV2RequestContext();
  const publicationFence = () => {
    validate?.();
    context?.permit.assertCurrent();
    if (context?.intent !== "cleanup") session.consentPermit?.assertCurrent();
  };
  publicationFence();
  if (context?.intent === "cleanup") {
    if (
      !["turn.aborted", "session.exited", "request.resolved", "user-input.resolved"].includes(
        event.type,
      )
    )
      return;
  } else session.consentPermit?.assertCurrent();
  if (session.emitted.size >= 20000) throw new Error("V2 canonical event safety bound exceeded.");
  await emit(event, publicationFence);
  publicationFence();
  session.emitted.add(event.eventId);
  completeV2Interaction(session, event);
}
