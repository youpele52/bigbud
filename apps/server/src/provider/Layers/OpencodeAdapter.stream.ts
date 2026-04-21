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
import { type Event as OpencodeEvent } from "@opencode-ai/sdk";
import { Effect, ServiceMap } from "effect";

import { type EventId, type ProviderRuntimeEvent } from "@bigbud/contracts";

import type { ActiveOpencodeSession } from "./OpencodeAdapter.types.ts";
import { withOpencodeDirectory, toMessage } from "./OpencodeAdapter.stream.utils.ts";
import { logNativeEvent, type SyntheticEventFn } from "./OpencodeAdapter.stream.primitives.ts";
import { makeMapEvent } from "./OpencodeAdapter.stream.mapEvent.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

export * from "./OpencodeAdapter.stream.utils.ts";
export * from "./OpencodeAdapter.stream.primitives.ts";
export * from "./OpencodeAdapter.stream.mapEvent.ts";

// ── Handle event (wires mapEvent into the event loop) ─────────────────

export function makeHandleEvent(
  nextEventId: Effect.Effect<EventId>,
  makeEventStamp: () => Effect.Effect<{ eventId: EventId; createdAt: string }>,
  nativeEventLogger: EventNdjsonLogger | undefined,
  emitFn: (events: ReadonlyArray<ProviderRuntimeEvent>) => Effect.Effect<void>,
  scheduleAutoApprovePendingPermission: (session: ActiveOpencodeSession, requestId: string) => void,
) {
  const mapEventFn = makeMapEvent(nextEventId, makeEventStamp);
  return Effect.fn("handleEvent")(function* (session: ActiveOpencodeSession, event: OpencodeEvent) {
    session.updatedAt = new Date().toISOString();

    // Append to current turn snapshot
    if (session.turns.length > 0) {
      session.turns.at(-1)?.items.push(event);
    }

    yield* logNativeEvent(nativeEventLogger, session.threadId, event);
    const mapped = yield* mapEventFn(session, event);
    if (mapped.length > 0) {
      yield* emitFn(mapped);

      if (session.runtimeMode === "full-access") {
        for (const mappedEvent of mapped) {
          if (mappedEvent.type === "request.opened" && mappedEvent.requestId) {
            scheduleAutoApprovePendingPermission(session, mappedEvent.requestId);
          }
        }
      }
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
): void {
  const abortController = new AbortController();
  session.sseAbortController = abortController;

  void (async () => {
    try {
      const { stream } = await session.client.event.subscribe(
        withOpencodeDirectory(session.cwd, {
          signal: abortController.signal,
        }),
      );
      for await (const event of stream) {
        if (abortController.signal.aborted) break;

        // Filter events to only those for this session.
        // The sessionID can live in different places depending on
        // event type, so we check several known locations.
        const props = event.properties as Record<string, unknown>;
        const eventSessionId =
          (props.sessionID as string | undefined) ??
          ((props.info as Record<string, unknown> | undefined)?.sessionID as string | undefined) ??
          ((props.session as Record<string, unknown> | undefined)?.id as string | undefined);

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
    } catch (err) {
      // Only log if this wasn't an intentional abort
      if (!abortController.signal.aborted) {
        console.error(
          `[opencode-adapter] SSE stream error for session=${session.opencodeSessionId}:`,
          err,
        );
        // Emit a runtime error so the UI can surface the connection issue
        makeSyntheticEvent(session.threadId, "runtime.error", {
          message: toMessage(err, "SSE event stream disconnected unexpectedly."),
          class: "transport_error",
        })
          .pipe(
            Effect.flatMap((evt) => emitFn([evt])),
            Effect.runPromiseWith(services),
          )
          .catch(() => {
            console.error(
              `[opencode-adapter] Failed to emit SSE disconnect error for session=${session.opencodeSessionId}`,
            );
          });
      }
    }
  })();
}
