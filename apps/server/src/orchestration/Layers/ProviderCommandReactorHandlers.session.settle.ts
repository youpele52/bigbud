import type { OrchestrationSession, OrchestrationThread } from "@bigbud/contracts";
import { Effect } from "effect";

import type { ProviderServiceError } from "../../provider/Errors.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { buildThreadReconciliationCommand } from "./ProviderRuntimeIngestion.reconcile.ts";

export function settleInterruptAfterAcknowledgement(input: {
  readonly event: {
    readonly payload: { readonly threadId: OrchestrationThread["id"]; readonly createdAt: string };
  };
  readonly thread: OrchestrationThread;
  readonly providerService: typeof ProviderService.Service;
  readonly setThreadSession: (input: {
    readonly threadId: OrchestrationThread["id"];
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) => Effect.Effect<void, OrchestrationDispatchError, never>;
}): Effect.Effect<void, ProviderServiceError | OrchestrationDispatchError, never> {
  return Effect.gen(function* () {
    let settledRuntimeSession = yield* input.providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.thread.id)),
      );
    if (isActive(settledRuntimeSession)) return;

    if (!settledRuntimeSession) {
      yield* Effect.sleep("100 millis");
      settledRuntimeSession = yield* input.providerService
        .listSessions()
        .pipe(
          Effect.map((sessions) =>
            sessions.find((session) => session.threadId === input.thread.id),
          ),
        );
      if (isActive(settledRuntimeSession)) return;
    }

    const reconciliation = buildThreadReconciliationCommand({
      thread: input.thread,
      liveSession: settledRuntimeSession,
      occurredAt: input.event.payload.createdAt,
    });
    if (reconciliation?.type === "thread.session.set") {
      yield* input.setThreadSession({
        threadId: input.thread.id,
        session: reconciliation.session,
        createdAt: input.event.payload.createdAt,
      });
    }
  });
}

function isActive(
  session:
    | {
        readonly activeTurnId?: unknown;
        readonly status: string;
      }
    | undefined,
): boolean {
  return (
    session?.activeTurnId != null ||
    session?.status === "connecting" ||
    session?.status === "running"
  );
}
