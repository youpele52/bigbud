/**
 * OpencodeAdapter stream — barrel re-exporting all stream sub-modules,
 * containing `makeHandleEvent` (wires mapEvent + primitives) and
 * `startEventStream`.
 *
 * Sub-modules:
 * - `OpencodeAdapter.stream.utils.ts`    — pure helper functions
 * - `OpencodeAdapter.stream.primitives.ts` — factory fns (event IDs, emit, synthetic events)
 * - `OpencodeAdapter.stream.mapEvent.ts`  — `makeMapEvent` implementation
 *
 * @module OpencodeAdapter.stream
 */
import { type Event as OpencodeEvent } from "@opencode-ai/sdk/v2";
import { Effect, ServiceMap } from "effect";

import { type EventId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { PROVIDER_RECOVERING_SESSION_REASON } from "@bigbud/contracts/constants/providerRuntime.constant";

import type { ActiveOpencodeSession } from "./Adapter.types.ts";
import { toMessage } from "./Adapter.stream.utils.ts";
import { logNativeEvent, type SyntheticEventFn } from "./Adapter.stream.primitives.ts";
import { makeMapEvent } from "./Adapter.stream.mapEvent.ts";
import type { EventNdjsonLogger } from "../EventNdjsonLogger.ts";

export * from "./Adapter.stream.utils.ts";
export * from "./Adapter.stream.primitives.ts";
export * from "./Adapter.stream.mapEvent.ts";

// ── Handle event (wires mapEvent into the event loop) ─────────────────

export function makeHandleEvent(
  nextEventId: Effect.Effect<EventId>,
  makeEventStamp: () => Effect.Effect<{ eventId: EventId; createdAt: string }>,
  nativeEventLogger: EventNdjsonLogger | undefined,
  emitFn: (events: ReadonlyArray<ProviderRuntimeEvent>) => Effect.Effect<void>,
  scheduleAutoApprovePendingPermission: (session: ActiveOpencodeSession, requestId: string) => void,
  provider: import("@bigbud/contracts").ProviderKind,
) {
  const mapEventFn = makeMapEvent(nextEventId, makeEventStamp, provider);
  return Effect.fn("handleEvent")(function* (session: ActiveOpencodeSession, event: OpencodeEvent) {
    session.updatedAt = new Date().toISOString();

    // Append to current turn snapshot
    if (session.turns.length > 0) {
      session.turns.at(-1)?.items.push(event);
    }

    yield* logNativeEvent(nativeEventLogger, session.threadId, event);
    const mapped = yield* mapEventFn(session, event);
    if (mapped.length > 0) {
      if (session.runtimeMode === "full-access") {
        const requiresExplicitApproval =
          event.type === "permission.asked" &&
          (event.properties as { permission?: string }).permission === "external_directory";
        const visibleEvents = [] as ProviderRuntimeEvent[];
        for (const mappedEvent of mapped) {
          if (
            mappedEvent.type === "request.opened" &&
            mappedEvent.requestId &&
            !requiresExplicitApproval
          ) {
            scheduleAutoApprovePendingPermission(session, mappedEvent.requestId);
            continue;
          }
          visibleEvents.push(mappedEvent);
        }
        if (visibleEvents.length > 0) {
          yield* emitFn(visibleEvents);
        }
        return;
      }

      yield* emitFn(mapped);
    }
  });
}

// ── SSE stream management ─────────────────────────────────────────────

/**
 * Start the SSE event stream for a session.
 * Runs in the background, piping events until the abort controller fires.
 */
export function startEventStream(
  session: ActiveOpencodeSession,
  handleEventFn: (session: ActiveOpencodeSession, event: OpencodeEvent) => Effect.Effect<void>,
  makeSyntheticEvent: SyntheticEventFn,
  emitFn: (events: ReadonlyArray<ProviderRuntimeEvent>) => Effect.Effect<void>,
  services: ServiceMap.ServiceMap<never>,
  reconcileActiveTurn?: (session: ActiveOpencodeSession) => Promise<void>,
  recovery?: {
    readonly retryDelays?: ReadonlyArray<number>;
    readonly random?: () => number;
  },
): { stop(): void; invalidate(): void } {
  const abortController = new AbortController();
  session.sseAbortController = abortController;
  let invalidated = false;
  let healthNotificationEmitted = false;
  const isOwner = () => session.sseAbortController === abortController;
  const reconcile = async () => {
    if (session.activeTurnId && isOwner())
      await reconcileActiveTurn?.(session).catch(() => undefined);
  };
  const emitHealth = async (message: string, turnId = session.activeTurnId) => {
    if (
      !isOwner() ||
      healthNotificationEmitted ||
      turnId === undefined ||
      session.activeTurnId !== turnId
    )
      return;
    healthNotificationEmitted = true;
    await makeSyntheticEvent(
      session.threadId,
      session.sessionEpoch,
      "session.state.changed",
      {
        state: "error",
        reason: PROVIDER_RECOVERING_SESSION_REASON,
        detail: { message },
      },
      { turnId },
    )
      .pipe(
        Effect.flatMap((event) => emitFn([event])),
        Effect.runPromiseWith(services),
      )
      .catch(() => undefined);
  };

  void (async () => {
    const retryDelays = recovery?.retryDelays ?? [100, 200, 400];
    const random = recovery?.random ?? Math.random;
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      try {
        if (abortController.signal.aborted || !isOwner()) return;
        if (attempt > 0) await reconcile();
        if (abortController.signal.aborted || !isOwner()) return;
        const { stream } = await session.client.event.subscribe(undefined, {
          signal: abortController.signal,
        });
        if (attempt > 0) await reconcile();
        for await (const event of stream) {
          if (abortController.signal.aborted || !isOwner()) return;

          // Filter events to only those for this session.
          // In v2, sessionID is always on event.properties.sessionID.
          const eventSessionId = (event.properties as Record<string, unknown>).sessionID as
            | string
            | undefined;

          if (eventSessionId && eventSessionId !== session.opencodeSessionId) {
            continue;
          }

          await handleEventFn(session, event)
            .pipe(Effect.runPromiseWith(services))
            .catch((err) => {
              console.error(
                `[opencode-adapter] handleEvent error for session=${session.opencodeSessionId} event.type=${event.type}:`,
                err,
              );
            });
        }
        if (abortController.signal.aborted || !isOwner()) return;
        throw new Error("SSE event stream ended unexpectedly.");
      } catch (error) {
        if (abortController.signal.aborted || !isOwner()) return;
        if (attempt === retryDelays.length) {
          const turnId = session.activeTurnId;
          await reconcile();
          await emitHealth(
            invalidated
              ? "OpenCode server process stopped unexpectedly. The active turn remains unresolved."
              : toMessage(
                  error,
                  "SSE event stream recovery was exhausted. The active turn remains unresolved.",
                ),
            turnId,
          );
          return;
        }
        await reconcile();
        const delay = retryDelays[attempt]!;
        await new Promise<void>((resolve) => {
          const onAbort = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(
            () => {
              abortController.signal.removeEventListener("abort", onAbort);
              resolve();
            },
            delay + Math.floor(random() * Math.max(1, delay / 4)),
          );
          abortController.signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    }
  })();
  return {
    stop: () => {
      if (isOwner()) {
        abortController.abort();
        session.sseAbortController = null;
      }
    },
    invalidate: () => {
      invalidated = true;
      const turnId = session.activeTurnId;
      abortController.abort();
      void reconcile().then(() =>
        emitHealth(
          "OpenCode server process stopped unexpectedly. The active turn remains unresolved.",
          turnId,
        ),
      );
    },
  };
}
