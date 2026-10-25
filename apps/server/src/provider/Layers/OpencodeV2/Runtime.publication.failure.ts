import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { onProviderPublicationRejected } from "../../providerPublication.ts";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";

/** Adapter enqueue is not end-consumer delivery. Keep IDs/journal evidence, but report
 * uncertainty if an actual downstream guard drops output; never replay accepted output
 * or infer a universal multi-subscriber acknowledgement from a PubSub enqueue.
 */
export function watchV2OutputPublication(
  runtime: OpencodeV2Runtime,
  owner: V2RuntimeSession,
  event: ProviderRuntimeEvent,
  epoch: number,
): void {
  if (!event.turnId || !["item.completed", "content.delta", "turn.completed"].includes(event.type))
    return;
  onProviderPublicationRejected(event, () => {
    if (
      runtime.sessions.get(owner.threadId) !== owner ||
      owner.stopped ||
      owner.epoch !== epoch ||
      owner.row?.turnId !== event.turnId ||
      owner.publicationUnconfirmed
    )
      return;
    owner.publicationUnconfirmed = true;
    owner.terminalDelivered = false;
    owner.session = {
      ...owner.session,
      status: "error",
      lastError:
        "V2 canonical publication state remains unconfirmed; native history retained, no automatic resend or replacement.",
    };
    runtime.scheduleRepair(owner, false);
  });
}
