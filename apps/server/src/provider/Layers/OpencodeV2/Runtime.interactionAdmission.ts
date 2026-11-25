import {
  holdUndispatchedInteraction,
  refusePendingInteractions,
} from "../../pendingInteractionAdmission.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";

/** Only root interactions observed from their native owner have exact reply proof. */
export function assertV2InteractionAdmission(session: V2RuntimeSession) {
  const approvals = new Map<string, object>();
  const userInputs = new Map<string, object>();
  let unconfirmed = Boolean(session.coding?.pending().length);
  for (const event of session.pendingInteractions?.values() ?? []) {
    if (event.type !== "request.opened" && event.type !== "user-input.requested") continue;
    if (
      event.requestId === undefined ||
      event.requestGeneration === undefined ||
      event.sessionEpoch !== session.epoch
    ) {
      unconfirmed = true;
      continue;
    }
    (event.type === "request.opened" ? approvals : userInputs).set(event.requestId, event);
  }
  if (unconfirmed) throw holdUndispatchedInteraction("opencodeV2", session.epoch);
  const refusal = refusePendingInteractions({
    provider: "opencodeV2",
    sessionEpoch: session.epoch,
    approvals,
    userInputs,
    generationFor: (id, owner) =>
      "requestGeneration" in owner && typeof owner.requestGeneration === "string"
        ? owner.requestGeneration
        : id,
  });
  if (refusal) throw refusal;
}
