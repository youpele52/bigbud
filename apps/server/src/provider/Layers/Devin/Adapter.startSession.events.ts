import { type ProviderRuntimeEvent, type ThreadId } from "@bigbud/contracts";
import { Effect, Scope, Stream } from "effect";

import {
  type DevinAdapterLiveOptions,
  type DevinEventStamp,
  type DevinSessionContext,
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpToolCallEvent,
  PROVIDER,
} from "./Adapter.helpers.ts";

interface DevinStartSessionEventDeps {
  readonly nativeEventLogger: DevinAdapterLiveOptions["nativeEventLogger"] | undefined;
  readonly makeEventStamp: () => Effect.Effect<DevinEventStamp>;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
}

export function logNative(
  deps: Pick<DevinStartSessionEventDeps, "nativeEventLogger">,
  threadId: ThreadId,
  method: string,
  payload: unknown,
) {
  return Effect.gen(function* () {
    if (!deps.nativeEventLogger) return;
    const observedAt = new Date().toISOString();
    yield* deps.nativeEventLogger.write(
      {
        observedAt,
        event: {
          id: crypto.randomUUID(),
          kind: "notification",
          provider: PROVIDER,
          createdAt: observedAt,
          method,
          threadId,
          payload,
        },
      },
      threadId,
    );
  });
}

export function emitPlanUpdate(
  deps: Pick<DevinStartSessionEventDeps, "makeEventStamp" | "offerRuntimeEvent">,
  ctx: DevinSessionContext,
  payload: {
    readonly explanation?: string | null;
    readonly plan: ReadonlyArray<{
      readonly step: string;
      readonly status: "pending" | "inProgress" | "completed";
    }>;
  },
  rawPayload: unknown,
  source: "acp.jsonrpc",
  method: string,
) {
  return Effect.gen(function* () {
    const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${JSON.stringify(payload)}`;
    if (ctx.lastPlanFingerprint === fingerprint) {
      return;
    }
    ctx.lastPlanFingerprint = fingerprint;
    yield* deps.offerRuntimeEvent(
      makeAcpPlanUpdatedEvent({
        stamp: yield* deps.makeEventStamp(),
        provider: PROVIDER,
        threadId: ctx.threadId,
        turnId: ctx.activeTurnId,
        payload,
        source,
        method,
        rawPayload,
      }),
    );
  });
}

export function forkNotificationFiber(
  deps: DevinStartSessionEventDeps,
  ctx: DevinSessionContext,
  scope: Scope.Scope,
) {
  return Stream.runDrain(
    Stream.mapEffect(ctx.acp.getEvents(), (event) =>
      Effect.gen(function* () {
        switch (event._tag) {
          case "ModeChanged":
            return;
          case "AssistantItemStarted":
            yield* deps.offerRuntimeEvent(
              makeAcpAssistantItemEvent({
                stamp: yield* deps.makeEventStamp(),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId: ctx.activeTurnId,
                itemId: event.itemId,
                lifecycle: "item.started",
              }),
            );
            return;
          case "AssistantItemCompleted":
            yield* deps.offerRuntimeEvent(
              makeAcpAssistantItemEvent({
                stamp: yield* deps.makeEventStamp(),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId: ctx.activeTurnId,
                itemId: event.itemId,
                lifecycle: "item.completed",
              }),
            );
            return;
          case "PlanUpdated":
            yield* logNative(deps, ctx.threadId, "session/update", event.rawPayload);
            yield* emitPlanUpdate(
              deps,
              ctx,
              event.payload,
              event.rawPayload,
              "acp.jsonrpc",
              "session/update",
            );
            return;
          case "ToolCallUpdated":
            yield* logNative(deps, ctx.threadId, "session/update", event.rawPayload);
            yield* deps.offerRuntimeEvent(
              makeAcpToolCallEvent({
                stamp: yield* deps.makeEventStamp(),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId: ctx.activeTurnId,
                toolCall: event.toolCall,
                rawPayload: event.rawPayload,
              }),
            );
            return;
          case "ContentDelta":
            yield* logNative(deps, ctx.threadId, "session/update", event.rawPayload);
            yield* deps.offerRuntimeEvent(
              makeAcpContentDeltaEvent({
                stamp: yield* deps.makeEventStamp(),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId: ctx.activeTurnId,
                ...(event.itemId ? { itemId: event.itemId } : {}),
                text: event.text,
                rawPayload: event.rawPayload,
              }),
            );
            return;
        }
      }),
    ),
  ).pipe(Effect.forkIn(scope));
}
