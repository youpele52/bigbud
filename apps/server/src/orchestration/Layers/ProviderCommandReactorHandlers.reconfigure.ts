import type { ThreadId } from "@bigbud/contracts";
import { Cause, Effect } from "effect";

import type { ProviderServiceError } from "../../provider/Errors.ts";
import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import type { SessionOpServices } from "./ProviderCommandReactorSessionOps.types.ts";
import { ensureSessionForThread } from "./ProviderCommandReactorSessionOps.ts";
import type { ProviderIntentEvent } from "./ProviderCommandReactorHandlers.events.ts";

export function makeExecutionTargetReconfigureHandler(sessionOpServices: SessionOpServices) {
  const processThreadExecutionTargetsUpdated = makeProcessThreadExecutionTargetsUpdated({
    providerService: sessionOpServices.providerService,
    sessionOpServices,
    resolveThread: sessionOpServices.resolveThread,
  });
  return (event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>) =>
    processThreadExecutionTargetsUpdated(event).pipe(Effect.asVoid);
}

export function makeProcessThreadExecutionTargetsUpdated(input: {
  readonly providerService: ProviderServiceShape;
  readonly sessionOpServices: SessionOpServices;
  readonly resolveThread: SessionOpServices["resolveThread"];
}) {
  return Effect.fn("processThreadExecutionTargetsUpdated")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>,
  ): Effect.fn.Return<void, ProviderServiceError | OrchestrationDispatchError> {
    if (
      event.payload.providerRuntimeExecutionTargetId === undefined ||
      event.payload.workspaceExecutionTargetId === undefined
    ) {
      return;
    }
    const thread = yield* input.resolveThread(event.payload.threadId);
    if (!thread?.session || thread.session.status === "stopped") {
      return;
    }
    const expectedSessionEpoch = thread.session.sessionEpoch ?? 0;
    const expectedActiveTurnId = thread.session.activeTurnId;
    yield* Effect.gen(function* () {
      yield* input.providerService.stopSession({
        threadId: thread.id,
        sessionEpoch: expectedSessionEpoch,
      });
      const current = yield* input.resolveThread(thread.id);
      if (
        !current?.session ||
        (current.session.sessionEpoch ?? 0) !== expectedSessionEpoch ||
        current.session.activeTurnId !== expectedActiveTurnId
      ) {
        return;
      }
      yield* ensureSessionForThread(input.sessionOpServices)(
        thread.id as ThreadId,
        event.occurredAt,
        {
          restartFreshIfInactive: true,
        },
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const current = yield* input.resolveThread(thread.id);
          const currentSessionEpoch = current?.session?.sessionEpoch ?? expectedSessionEpoch;
          const currentActiveTurnId = current?.session?.activeTurnId;
          yield* input.sessionOpServices.setThreadSession({
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "error",
              providerName: thread.session?.providerName ?? null,
              runtimeMode: thread.runtimeMode,
              activeTurnId: null,
              lastError: Cause.pretty(cause),
              updatedAt: event.occurredAt,
            },
            createdAt: event.occurredAt,
            expectedSessionEpoch: currentSessionEpoch,
            ...((currentActiveTurnId ?? expectedActiveTurnId)
              ? { expectedActiveTurnId: currentActiveTurnId ?? expectedActiveTurnId }
              : {}),
          });
          return yield* Effect.failCause(cause);
        }),
      ),
    );
  });
}
