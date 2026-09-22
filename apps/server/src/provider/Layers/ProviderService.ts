/** Cross-provider orchestration and provider-runtime event routing. */
import {
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderStopSessionInput,
  type ProviderKind,
  type ProviderRuntimeEvent,
  type ThreadId,
} from "@bigbud/contracts";
import { Effect, Layer, PubSub, Stream } from "effect";

import {
  providerMetricAttributes,
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  providerTurnMetricAttributes,
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
import { decodeInputOrValidationError, toValidationError } from "./ProviderServiceHelpers.ts";
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
import { makeProcessProviderRuntimeEvent } from "./ProviderService.runtimeEvents.ts";
import { ProviderTurnLivenessRepository } from "../../persistence/Services/ProviderTurnLiveness.ts";
import { recordAcceptedSendTurn } from "./ProviderService.sendTurn.record.ts";
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
    publish: (event) =>
      (canonicalEventLogger ? canonicalEventLogger.write(event, null) : Effect.void).pipe(
        Effect.andThen(PubSub.publish(runtimeEventPubSub, event)),
        Effect.asVoid,
      ),
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

  const sendTurn: ProviderServiceShape["sendTurn"] = Effect.fn("sendTurn")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.sendTurn",
      schema: ProviderSendTurnInput,
      payload: rawInput,
    });

    const input = { ...parsed, attachments: parsed.attachments ?? [] };
    if (!input.input && input.attachments.length === 0) {
      return yield* toValidationError(
        "ProviderService.sendTurn",
        "Either input text or at least one attachment is required",
      );
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "send-turn",
      "provider.thread_id": input.threadId,
      "provider.interaction_mode": input.interactionMode,
      "provider.attachment_count": input.attachments.length,
    });
    let metricProvider = "unknown";
    let metricModel = input.modelSelection?.model;
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.sendTurn",
        allowRecovery: true,
        ...(input.sessionEpoch !== undefined ? { expectedSessionEpoch: input.sessionEpoch } : {}),
      });
      metricProvider = routed.adapter.provider;
      metricModel = input.modelSelection?.model;
      yield* Effect.annotateCurrentSpan({
        "provider.kind": routed.adapter.provider,
        ...(input.modelSelection?.model ? { "provider.model": input.modelSelection.model } : {}),
      });
      const turn = yield* routed.adapter.sendTurn(input);
      yield* recordAcceptedSendTurn({
        adapter: routed.adapter,
        directory,
        liveness: turnLiveness,
        threadId: input.threadId,
        turnId: turn.turnId,
        sessionEpoch: input.sessionEpoch ?? 0,
        ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
        ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      });
      yield* analytics.record("provider.turn.sent", {
        provider: routed.adapter.provider,
        model: input.modelSelection?.model,
        interactionMode: input.interactionMode,
        attachmentCount: input.attachments.length,
        hasInput: typeof input.input === "string" && input.input.trim().length > 0,
      });
      return turn;
    }).pipe(
      Effect.mapError((e) => e as ProviderServiceError),
      withMetrics({
        counter: providerTurnsTotal,
        timer: providerTurnDuration,
        attributes: () =>
          providerTurnMetricAttributes({
            provider: metricProvider,
            model: metricModel,
            extra: { operation: "send" },
          }),
      }),
    );
  });

  const interruptTurn = makeInterruptTurn({
    resolveRoutableSession,
    analytics,
  });
  const steerTurn = makeSteerTurn({ resolveRoutableSession });

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
        yield* directory.remove(input.threadId);
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

  const runStopAll = makeRunStopAll(adapters, directory, upsertSessionBinding, analytics);

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
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  } satisfies ProviderServiceShape;
});

export const ProviderServiceLive = Layer.effect(ProviderService, makeProviderService());

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService, makeProviderService(options));
}
