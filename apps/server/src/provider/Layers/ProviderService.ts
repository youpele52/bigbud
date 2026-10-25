/** Cross-provider orchestration and provider-runtime event routing. */
import {
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderStopSessionInput,
  type ProviderKind,
  type ProviderRuntimeEvent,
  type ThreadId,
} from "@bigbud/contracts";
import { Effect, Layer, PubSub } from "effect";

import {
  providerMetricAttributes,
  providerSessionsTotal,
  providerTurnsTotal,
  withMetrics,
} from "../../observability/Metrics.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  getProviderCapabilities,
  type ProviderCapabilitiesResolver,
} from "../providerCapabilities.ts";
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { decodeInputOrValidationError } from "./ProviderServiceHelpers.ts";
import type { ProviderServiceError } from "../Errors.ts";
import { makeStartSessionInternal } from "./ProviderService.startSession.ts";
import {
  makeRecoverSessionForThread,
  makeResolveRoutableSession,
} from "./ProviderServiceSessionRouting.ts";
import {
  makeListSessions,
  makeListSessionsForReconciliation,
  makeRollbackConversation,
  makeRunStopAll,
} from "./ProviderService.operations.ts";
import {
  makeStopStaleSessionsForThread,
  makeUpsertSessionBinding,
} from "./ProviderService.sessionLifecycle.ts";
import {
  makeProcessProviderRuntimeEvent,
  makeCanonicalRuntimePublisher,
  canonicalRuntimeStream,
} from "./ProviderService.runtimeEvents.ts";
import { ProviderTurnLivenessRepository } from "../../persistence/Services/ProviderTurnLiveness.ts";
import { makeSendTurn } from "./ProviderService.sendTurn.ts";
import { ProviderDispatchAttemptRepository } from "../../persistence/Services/ProviderDispatchAttempts.ts";
import { ThreadRecoveryIntentRepository } from "../../persistence/Services/ThreadRecoveryIntents.ts";
import { suspendRecoveryIntentsForStopAll } from "./ProviderService.stopAll.ts";
import {
  makeTurnLivenessOperations,
  markProviderTurnTerminal,
  monitorProviderRuntimeEvents,
  observeProviderRuntimeEvent,
} from "./ProviderService.turnLiveness.ts";
import { makeInspectActiveTurn } from "./ProviderService.inspection.ts";
import { makeInterruptTurn } from "./ProviderService.interrupt.ts";
import { makeBackgroundReviews } from "./ProviderService.backgroundReview.ts";
import { makeSteerTurn } from "./ProviderService.steer.ts";
import { preserveStoppedProviderBinding } from "./ProviderService.stopSession.binding.ts";
import { makeStopSubagent } from "./ProviderService.subagentStop.ts";
import { makeStopThreadSubagents } from "./ProviderService.threadSubagentStop.ts";

export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogPath?: string;
  readonly canonicalEventLogger?: EventNdjsonLogger;
  readonly getProviderCapabilities?: ProviderCapabilitiesResolver;
  readonly isProviderComposed?: (provider: ProviderKind) => boolean;
  readonly settleThreadLogs?: (threadId: ThreadId) => Effect.Effect<void>;
}

const makeProviderService = Effect.fn("makeProviderService")(function* (
  options?: ProviderServiceLiveOptions,
) {
  const analytics = yield* Effect.service(AnalyticsService);
  const serverSettings = yield* ServerSettingsService;
  const resolveCapabilities = options?.getProviderCapabilities ?? getProviderCapabilities;
  const isProviderComposed = options?.isProviderComposed ?? (() => true);
  const canonicalEventLogger =
    options?.canonicalEventLogger ??
    (options?.canonicalEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.canonicalEventLogPath, { stream: "canonical" })
      : undefined);

  const registry = yield* ProviderAdapterRegistry;
  const directory = yield* ProviderSessionDirectory;
  const turnLiveness = yield* Effect.serviceOption(ProviderTurnLivenessRepository);
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

  const upsertSessionBinding = makeUpsertSessionBinding(directory);

  const providers = yield* registry.listProviders();
  const background = makeBackgroundReviews({
    registry,
    serverSettings,
    getProviderCapabilities: resolveCapabilities,
    isProviderComposed,
  });
  const adapters = yield* Effect.forEach(providers, (provider) =>
    registry.getByProvider(provider).pipe(Effect.map(background.forDiscovery)),
  );
  const processRuntimeEvent = makeProcessProviderRuntimeEvent({
    observe: (event) => observeProviderRuntimeEvent(turnLiveness, event),
    publish: makeCanonicalRuntimePublisher(runtimeEventPubSub, canonicalEventLogger),
  });

  yield* monitorProviderRuntimeEvents({
    adapters,
    liveness: turnLiveness,
    process: (event) =>
      background.isBackground(event.threadId)
        ? background.process(event)
        : processRuntimeEvent(event),
  });

  // Build session routing helpers
  const recoverSessionForThread = makeRecoverSessionForThread(
    registry,
    directory,
    upsertSessionBinding,
    analytics,
    resolveCapabilities,
  );
  const resolveRoutableSession = makeResolveRoutableSession(
    registry,
    directory,
    recoverSessionForThread,
    isProviderComposed,
  );

  const stopStaleSessionsForThread = makeStopStaleSessionsForThread(adapters, analytics);

  const startDependencies = {
    registry,
    directory,
    upsertSessionBinding,
    analytics,
    serverSettings,
    getProviderCapabilities: resolveCapabilities,
    isProviderComposed,
    stopStaleSessionsForThread,
  };
  const startSession = makeStartSessionInternal(startDependencies);
  const startSessionFresh = makeStartSessionInternal({
    ...startDependencies,
    options: { reusePersistedResumeCursor: false },
  });

  const sendTurn = makeSendTurn({
    resolveRoutableSession,
    directory,
    liveness: turnLiveness,
    dispatchAttempts: yield* Effect.serviceOption(ProviderDispatchAttemptRepository),
    analytics,
  });

  const interruptTurn = makeInterruptTurn({
    resolveRoutableSession,
    analytics,
  });
  const steerTurn = makeSteerTurn({ resolveRoutableSession });
  const stopSubagent = makeStopSubagent({ resolveRoutableSession });
  const stopThreadSubagents = makeStopThreadSubagents({ resolveRoutableSession });

  const inspectActiveTurn = makeInspectActiveTurn(registry, directory);

  const respondToRequest: ProviderServiceShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.respondToRequest",
        schema: ProviderRespondToRequestInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToRequest",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "respond-to-request",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.request_id": input.requestId,
        });
        yield* routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision);
        yield* analytics.record("provider.request.responded", {
          provider: routed.adapter.provider,
          decision: input.decision,
        });
      }).pipe(
        Effect.mapError((e) => e as ProviderServiceError),
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, { operation: "approval-response" }),
        }),
      );
    },
  );

  const respondToUserInput: ProviderServiceShape["respondToUserInput"] = Effect.fn(
    "respondToUserInput",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.respondToUserInput",
      schema: ProviderRespondToUserInputInput,
      payload: rawInput,
    });
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.respondToUserInput",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "respond-to-user-input",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.request_id": input.requestId,
      });
      yield* routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers);
    }).pipe(
      Effect.mapError((e) => e as ProviderServiceError),
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, { operation: "user-input-response" }),
      }),
    );
  });

  const stopSession: ProviderServiceShape["stopSession"] = Effect.fn("stopSession")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.stopSession",
        schema: ProviderStopSessionInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.stopSession",
          allowRecovery: false,
          ...(input.sessionEpoch !== undefined ? { expectedSessionEpoch: input.sessionEpoch } : {}),
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "stop-session",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
        });
        if (routed.isActive) {
          yield* routed.adapter.stopSession(routed.threadId);
        }
        yield* markProviderTurnTerminal(turnLiveness, {
          threadId: input.threadId,
          terminalAt: new Date().toISOString(),
        });
        yield* options?.settleThreadLogs?.(input.threadId) ?? Effect.void;
        yield* preserveStoppedProviderBinding(directory, input.threadId);
        yield* analytics.record("provider.session.stopped", { provider: routed.adapter.provider });
      }).pipe(
        Effect.mapError((e) => e as ProviderServiceError),
        withMetrics({
          counter: providerSessionsTotal,
          outcomeAttributes: () => providerMetricAttributes(metricProvider, { operation: "stop" }),
        }),
      );
    },
  );

  const listAdapterSessions = makeListSessions(adapters, directory);
  const listSessions: ProviderServiceShape["listSessions"] = listAdapterSessions;
  const listSessionsForReconciliation = makeListSessionsForReconciliation(adapters, directory);

  const { listActiveTurnLiveness, recordTurnInspection, claimTurnTerminal } =
    makeTurnLivenessOperations(turnLiveness);

  const getCapabilities: ProviderServiceShape["getCapabilities"] = (provider) =>
    registry.getByProvider(provider).pipe(Effect.map((adapter) => adapter.capabilities));

  const rollbackConversation: ProviderServiceShape["rollbackConversation"] =
    makeRollbackConversation(resolveRoutableSession, analytics);

  const recoveryIntents = yield* Effect.serviceOption(ThreadRecoveryIntentRepository);
  const runStopAll = makeRunStopAll(adapters, directory, upsertSessionBinding, analytics, {
    reason: "app-exit",
    suspendRecoveryIntents: (reason) => suspendRecoveryIntentsForStopAll(recoveryIntents, reason),
  });

  yield* Effect.addFinalizer(() =>
    Effect.catch(runStopAll, (cause) =>
      Effect.logWarning("failed to stop provider service", { cause }),
    ),
  );

  return {
    runBackgroundReview: background.run,
    startSession,
    startSessionFresh,
    sendTurn,
    interruptTurn,
    steerTurn,
    stopSubagent,
    stopThreadSubagents,
    inspectActiveTurn,
    listActiveTurnLiveness,
    recordTurnInspection,
    claimTurnTerminal,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    listSessionsForReconciliation,
    getCapabilities,
    rollbackConversation,
    // Each consumer independently receives all canonical runtime events.
    get streamEvents(): ProviderServiceShape["streamEvents"] {
      return canonicalRuntimeStream(runtimeEventPubSub);
    },
  } satisfies ProviderServiceShape;
});

export const ProviderServiceLive = Layer.effect(ProviderService, makeProviderService());

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService, makeProviderService(options));
}
