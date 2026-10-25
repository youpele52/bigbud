import { Effect } from "effect";
import type { ProviderIntentEvent } from "./ProviderCommandReactorHandlers.events.ts";
import type { SessionOpServices } from "./ProviderCommandReactorSessionOps.types.ts";
import { ensureSessionForThread } from "./ProviderCommandReactorSessionOps.ts";

/** Reconfigure a live runtime mode while retaining the previous session on failure. */
export function processRuntimeModeSet(
  services: SessionOpServices,
  event: Extract<ProviderIntentEvent, { type: "thread.runtime-mode-set" }>,
) {
  return Effect.gen(function* () {
    const thread = yield* services.resolveThread(event.payload.threadId);
    if (!thread?.session || thread.session.status === "stopped") return;
    const previousSession = thread.session;
    const cachedModelSelection = services.threadModelSelections.get(event.payload.threadId);
    yield* ensureSessionForThread(services)(
      event.payload.threadId,
      event.occurredAt,
      cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* services.setThreadSession({
            threadId: event.payload.threadId,
            session: previousSession,
            createdAt: event.occurredAt,
            expectedSessionEpoch: (previousSession.sessionEpoch ?? 0) + 1,
          });
          return yield* Effect.failCause(cause);
        }),
      ),
    );
  });
}
