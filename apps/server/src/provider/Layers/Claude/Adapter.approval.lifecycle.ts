import type { ApprovalRequestId, EventId } from "@bigbud/contracts";
import { Deferred, Effect } from "effect";

import type { ClaudeSessionContext } from "./Adapter.types.ts";
import { PROVIDER } from "./Adapter.types.ts";
import type { OfferClaudeRuntimeEvent } from "./Adapter.events.ts";
import { asRuntimeRequestId, nativeProviderRefs } from "./Adapter.utils.ts";

/** Finalize an owner that failed/interrupted before writing its resolved ledger entry. */
export const cancelAbandonedClaudeRequest = Effect.fn("cancelAbandonedClaudeRequest")(function* (
  context: ClaudeSessionContext,
  requestId: ApprovalRequestId,
  deps: {
    readonly makeEventStamp: () => Effect.Effect<{ eventId: EventId; createdAt: string }>;
    readonly offerRuntimeEvent: OfferClaudeRuntimeEvent;
  },
) {
  const entry = context.requestLedger.get(requestId);
  if (!entry || entry.state === "resolved") return;
  if (entry.state === "resolving") {
    // The publisher owns the single terminal event. Stop only fences its result;
    // it must not compete with that owner or replace its ledger entry.
    entry.cancelled = true;
    context.pendingApprovals.delete(requestId);
    context.pendingUserInputs.delete(requestId);
    Deferred.doneUnsafe(entry.completion, Effect.void);
    return;
  }
  const resolvedAt = new Date().toISOString();
  const result = { behavior: "deny" as const, message: "User cancelled tool execution." };
  const identity = {
    ...(entry.providerRequestId ? { providerRequestId: entry.providerRequestId } : {}),
    ...(entry.providerAgentId ? { providerAgentId: entry.providerAgentId } : {}),
    ...(entry.providerItemId ? { providerItemId: entry.providerItemId } : {}),
  };
  if (entry.kind === "approval") {
    context.pendingApprovals.delete(requestId);
    context.resolvedApprovals.set(requestId, "cancel");
    context.requestLedger.set(requestId, {
      ...entry,
      state: "resolved",
      resolvedAt,
      decision: "cancel",
      suggestions: [],
      result,
      sessionPermissionApplied: false,
    });
    Deferred.doneUnsafe(entry.completion, Effect.void);
    yield* Deferred.succeed(entry.decision, "cancel");
    const stamp = yield* deps.makeEventStamp();
    yield* deps.offerRuntimeEvent(context, {
      type: "request.resolved",
      ...stamp,
      provider: PROVIDER,
      threadId: context.session.threadId,
      requestId: asRuntimeRequestId(requestId),
      payload: { requestType: entry.requestType, decision: "cancel" },
      providerRefs: nativeProviderRefs(context, identity),
    });
  } else {
    entry.cancelled = true;
    const pending = context.pendingUserInputs.get(requestId);
    if (pending) pending.cancelled = true;
    context.pendingUserInputs.delete(requestId);
    context.resolvedUserInputs.set(requestId, {});
    context.requestLedger.set(requestId, {
      ...entry,
      state: "resolved",
      resolvedAt,
      answers: {},
      result,
      elicitationResult: { action: "cancel" },
    });
    Deferred.doneUnsafe(entry.completion, Effect.void);
    yield* Deferred.succeed(entry.answers, {});
    const stamp = yield* deps.makeEventStamp();
    yield* deps.offerRuntimeEvent(context, {
      type: "user-input.resolved",
      ...stamp,
      provider: PROVIDER,
      threadId: context.session.threadId,
      requestId: asRuntimeRequestId(requestId),
      payload: { answers: {} },
      providerRefs: nativeProviderRefs(context, identity),
    });
  }
});
