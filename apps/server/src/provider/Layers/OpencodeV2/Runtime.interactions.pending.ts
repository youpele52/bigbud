import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { runtimeEventBase } from "./Runtime.projection.ts";

/** Close only interaction IDs previously observed for this exact owner/turn; never send native replies. */
export function invalidateV2Interactions(
  session: V2RuntimeSession,
  retained = new Set<string>(),
  answers = new Map<string, Record<string, unknown>>(),
) {
  const events: ProviderRuntimeEvent[] = [];
  for (const [key, opened] of session.pendingInteractions ?? []) {
    if (retained.has(key)) continue;
    if (opened.type === "user-input.requested" || opened.type === "request.opened") {
      events.push({
        ...runtimeEventBase(
          session,
          `${opened.type === "request.opened" ? "permission" : "form"}-resolved:${opened.requestId}`,
        ),
        sessionEpoch: opened.sessionEpoch,
        ...(opened.turnId ? { turnId: opened.turnId } : {}),
        requestId: opened.requestId,
        ...(opened.type === "request.opened"
          ? {
              type: "request.resolved" as const,
              payload: { requestType: opened.payload.requestType, decision: "cancel" as const },
            }
          : { type: "user-input.resolved" as const, payload: { answers: answers.get(key) ?? {} } }),
      });
    }
  }
  return events;
}

/** Retain requests until canonical resolution publication succeeds, including sink-failure repair. */
export function completeV2Interaction(session: V2RuntimeSession, event: ProviderRuntimeEvent) {
  if (event.type === "request.resolved")
    session.pendingInteractions?.delete(`request.opened:${event.requestId}`);
  if (event.type === "request.resolved")
    session.pendingInteractions?.delete(`request.resolved:${event.requestId}`);
  if (event.type === "user-input.resolved")
    session.pendingInteractions?.delete(`user-input.requested:${event.requestId}`);
}
