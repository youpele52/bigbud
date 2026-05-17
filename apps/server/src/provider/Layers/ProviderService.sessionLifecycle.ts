import { LOCAL_EXECUTION_TARGET_ID, type ProviderSession, type ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import type { AnalyticsServiceShape } from "../../telemetry/Services/AnalyticsService.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type {
  ProviderSessionDirectoryShape,
  ProviderSessionDirectoryWriteError,
} from "../Services/ProviderSessionDirectory.ts";
import { resolveProviderSessionExecutionTargets } from "../providerSessionExecutionTargets.ts";
import { toRuntimePayloadFromSession, toRuntimeStatus } from "./ProviderServiceHelpers.ts";

type Adapter = ProviderAdapterShape<ProviderAdapterError>;

export function makeUpsertSessionBinding(directory: ProviderSessionDirectoryShape): (
  session: ProviderSession,
  threadId: ThreadId,
  extra?: {
    readonly modelSelection?: unknown;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
  },
) => Effect.Effect<void, ProviderSessionDirectoryWriteError> {
  return (session, threadId, extra) =>
    directory.upsert({
      threadId,
      provider: session.provider,
      ...resolveProviderSessionExecutionTargets({
        providerRuntimeExecutionTargetId: session.providerRuntimeExecutionTargetId,
        workspaceExecutionTargetId: session.workspaceExecutionTargetId,
        executionTargetId: session.executionTargetId,
        defaultProviderRuntimeExecutionTargetId: LOCAL_EXECUTION_TARGET_ID,
        defaultWorkspaceExecutionTargetId: LOCAL_EXECUTION_TARGET_ID,
      }),
      runtimeMode: session.runtimeMode,
      status: toRuntimeStatus(session),
      ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
      runtimePayload: toRuntimePayloadFromSession(session, extra),
    });
}

export function makeStopStaleSessionsForThread(
  adapters: ReadonlyArray<Adapter>,
  analytics: AnalyticsServiceShape,
): (input: {
  readonly threadId: ThreadId;
  readonly currentProvider: ProviderSession["provider"];
}) => Effect.Effect<void> {
  return Effect.fn("stopStaleSessionsForThread")(function* (input) {
    yield* Effect.forEach(
      adapters,
      (adapter) =>
        adapter.provider === input.currentProvider
          ? Effect.void
          : Effect.gen(function* () {
              const hasSession = yield* adapter.hasSession(input.threadId);
              if (!hasSession) {
                return;
              }

              yield* adapter.stopSession(input.threadId).pipe(
                Effect.tap(() =>
                  analytics.record("provider.session.stopped", { provider: adapter.provider }),
                ),
                Effect.catchCause((cause) =>
                  Effect.logWarning("provider.session.stop-stale-failed", {
                    threadId: input.threadId,
                    provider: adapter.provider,
                    cause,
                  }),
                ),
              );
            }),
      { discard: true },
    );
  });
}
