/**
 * Bulk-operation helpers for ProviderService.
 *
 * Extracted from ProviderService.ts to keep that file under 500 lines.
 * Each factory function accepts its dependencies as parameters to avoid
 * closing over the parent's local scope.
 *
 * @module ProviderService.operations
 */
import { type ProviderSession, type ThreadId } from "@bigbud/contracts";
import { Effect, Option } from "effect";

import {
  providerMetricAttributes,
  providerTurnsTotal,
  withMetrics,
} from "../../observability/Metrics.ts";
import type { AnalyticsServiceShape } from "../../telemetry/Services/AnalyticsService.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterError, ProviderServiceError } from "../Errors.ts";
import type {
  ProviderSessionDirectoryShape,
  ProviderSessionDirectoryWriteError,
} from "../Services/ProviderSessionDirectory.ts";
import type { ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  decodeInputOrValidationError,
  ProviderRollbackConversationInput,
} from "./ProviderServiceHelpers.ts";
import type { makeResolveRoutableSession } from "./ProviderServiceSessionRouting.ts";
import { resolveProviderSessionExecutionTargets } from "../providerSessionExecutionTargets.ts";

/** Return type of `makeResolveRoutableSession` — the curried session resolver. */
export type ResolveRoutableSession = ReturnType<typeof makeResolveRoutableSession>;

type Adapter = ProviderAdapterShape<ProviderAdapterError>;

type UpsertSessionBinding = (
  session: ProviderSession,
  threadId: ThreadId,
  extra?: {
    readonly modelSelection?: unknown;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
  },
) => Effect.Effect<void, ProviderSessionDirectoryWriteError>;

/**
 * Returns a `listSessions` implementation that merges live adapter sessions
 * with persisted directory bindings.
 */
export function makeListSessions(
  adapters: ReadonlyArray<Adapter>,
  directory: ProviderSessionDirectoryShape,
): ProviderServiceShape["listSessions"] {
  return Effect.fn("listSessions")(function* () {
    const sessionsByProvider = yield* Effect.forEach(adapters, (adapter) => adapter.listSessions());
    const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);
    const persistedBindings = yield* directory.listThreadIds().pipe(
      Effect.flatMap((threadIds) =>
        Effect.forEach(
          threadIds,
          (threadId) =>
            directory.getBinding(threadId).pipe(Effect.orElseSucceed(() => Option.none<any>())),
          { concurrency: "unbounded" },
        ),
      ),
      Effect.orElseSucceed(() => [] as Array<Option.Option<any>>),
    );
    const bindingsByThreadId = new Map<ThreadId, any>();
    for (const bindingOption of persistedBindings) {
      const binding = Option.getOrUndefined(bindingOption);
      if (binding) {
        bindingsByThreadId.set(binding.threadId, binding);
      }
    }

    return activeSessions.map((session) => {
      const binding = bindingsByThreadId.get(session.threadId);
      if (!binding) return session;

      const overrides: {
        providerRuntimeExecutionTargetId?: ProviderSession["providerRuntimeExecutionTargetId"];
        workspaceExecutionTargetId?: ProviderSession["workspaceExecutionTargetId"];
        executionTargetId?: ProviderSession["executionTargetId"];
        resumeCursor?: ProviderSession["resumeCursor"];
        runtimeMode?: ProviderSession["runtimeMode"];
      } = {};
      const executionTargets = resolveProviderSessionExecutionTargets({
        providerRuntimeExecutionTargetId:
          session.providerRuntimeExecutionTargetId ?? binding.providerRuntimeExecutionTargetId,
        workspaceExecutionTargetId:
          session.workspaceExecutionTargetId ?? binding.workspaceExecutionTargetId,
        executionTargetId: session.executionTargetId ?? binding.executionTargetId,
        defaultProviderRuntimeExecutionTargetId:
          binding.providerRuntimeExecutionTargetId ?? binding.executionTargetId,
        defaultWorkspaceExecutionTargetId:
          binding.workspaceExecutionTargetId ?? binding.executionTargetId,
      });
      if (session.providerRuntimeExecutionTargetId === undefined) {
        overrides.providerRuntimeExecutionTargetId =
          executionTargets.providerRuntimeExecutionTargetId;
      }
      if (session.workspaceExecutionTargetId === undefined) {
        overrides.workspaceExecutionTargetId = executionTargets.workspaceExecutionTargetId;
      }
      if (session.executionTargetId === undefined) {
        overrides.executionTargetId = executionTargets.executionTargetId;
      }
      if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
        overrides.resumeCursor = binding.resumeCursor;
      }
      if (binding.runtimeMode !== undefined) {
        overrides.runtimeMode = binding.runtimeMode;
      }
      return Object.assign({}, session, overrides);
    });
  });
}

/**
 * Returns a `rollbackConversation` implementation that delegates to the
 * routable session's adapter.
 */
export function makeRollbackConversation(
  resolveRoutableSession: ResolveRoutableSession,
  analytics: AnalyticsServiceShape,
): ProviderServiceShape["rollbackConversation"] {
  return Effect.fn("rollbackConversation")(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.rollbackConversation",
      schema: ProviderRollbackConversationInput,
      payload: rawInput,
    });
    if (input.numTurns === 0) return;
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.rollbackConversation",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "rollback-conversation",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.rollback_turns": input.numTurns,
      });
      yield* routed.adapter.rollbackThread(routed.threadId, input.numTurns);
      yield* analytics.record("provider.conversation.rolled_back", {
        provider: routed.adapter.provider,
        turns: input.numTurns,
      });
    }).pipe(
      Effect.mapError((e) => e as ProviderServiceError),
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, { operation: "rollback" }),
      }),
    );
  });
}

/**
 * Builds an Effect that stops all active provider sessions and marks bindings
 * as stopped in the directory. Uses `Effect.gen` to avoid the IIFE pattern.
 */
export function makeRunStopAll(
  adapters: ReadonlyArray<Adapter>,
  directory: ProviderSessionDirectoryShape,
  upsertSessionBinding: UpsertSessionBinding,
  analytics: AnalyticsServiceShape,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const threadIds = yield* directory.listThreadIds();
    const activeSessions = yield* Effect.forEach(adapters, (adapter) =>
      adapter.listSessions(),
    ).pipe(Effect.map((sessionsByAdapter) => sessionsByAdapter.flatMap((sessions) => sessions)));
    yield* Effect.forEach(activeSessions, (session) =>
      upsertSessionBinding(session, session.threadId, {
        lastRuntimeEvent: "provider.stopAll",
        lastRuntimeEventAt: new Date().toISOString(),
      }),
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(adapters, (adapter) => adapter.stopAll()).pipe(Effect.asVoid);
    yield* Effect.forEach(threadIds, (threadId) =>
      directory.getProvider(threadId).pipe(
        Effect.flatMap((provider) =>
          directory.upsert({
            threadId,
            provider,
            status: "stopped",
            runtimePayload: {
              activeTurnId: null,
              lastRuntimeEvent: "provider.stopAll",
              lastRuntimeEventAt: new Date().toISOString(),
            },
          }),
        ),
      ),
    ).pipe(Effect.asVoid);
    yield* analytics.record("provider.sessions.stopped_all", { sessionCount: threadIds.length });
    yield* analytics.flush;
  }).pipe(Effect.withSpan("runStopAll"), Effect.orDie);
}
