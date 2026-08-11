import type { OrchestrationThread, ProviderRuntimeEvent } from "@bigbud/contracts";
import { Effect } from "effect";

import { ProviderService } from "../../provider/Services/ProviderService.ts";

/** Reads optional live fencing evidence without dropping lifecycle events on lookup errors. */
export function lookupLiveSessionBestEffort(input: {
  readonly providerService: typeof ProviderService.Service;
  readonly thread: OrchestrationThread;
  readonly event: ProviderRuntimeEvent;
}) {
  return input.providerService.listSessions().pipe(
    Effect.map((sessions) => sessions.find((session) => session.threadId === input.thread.id)),
    Effect.catchCause(() =>
      Effect.logWarning(
        "provider lifecycle session lookup failed; applying event with projected fence",
        {
          threadId: input.thread.id,
          eventId: input.event.eventId,
          eventType: input.event.type,
        },
      ).pipe(Effect.as(undefined)),
    ),
  );
}
