/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import {
  LOCAL_EXECUTION_TARGET_ID,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  type ProviderRuntimeEvent,
} from "@bigbud/contracts";
import { Effect, Layer, Option, PubSub, Stream } from "effect";

import {
  increment,
  providerMetricAttributes,
  providerRuntimeEventsTotal,
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
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { toValidationError, decodeInputOrValidationError } from "./ProviderServiceHelpers.ts";
import type { ProviderServiceError } from "../Errors.ts";
import {
  makeRecoverSessionForThread,
  makeResolveRoutableSession,
} from "./ProviderServiceSessionRouting.ts";
import {
  makeListSessions,
  makeRollbackConversation,
  makeRunStopAll,
} from "./ProviderService.operations.ts";
import {
  makeStopStaleSessionsForThread,
  makeUpsertSessionBinding,
} from "./ProviderService.sessionLifecycle.ts";
import {
  formatUnsupportedProviderExecutionTargetDetail,
  supportsProviderExecutionTarget,
} from "../providerExecutionTargets.ts";
import { getProviderCapabilities } from "../providerCapabilities.ts";
import { resolveProviderSessionExecutionTargets } from "../providerSessionExecutionTargets.ts";

export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogPath?: string;
  readonly canonicalEventLogger?: EventNdjsonLogger;
}

const makeProviderService = Effect.fn("makeProviderService")(function* (
  options?: ProviderServiceLiveOptions,
) {
  const analytics = yield* Effect.service(AnalyticsService);
  const serverSettings = yield* ServerSettingsService;
  const canonicalEventLogger =
    options?.canonicalEventLogger ??
    (options?.canonicalEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.canonicalEventLogPath, { stream: "canonical" })
      : undefined);

  const registry = yield* ProviderAdapterRegistry;
  const directory = yield* ProviderSessionDirectory;
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

  const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Effect.succeed(event).pipe(
      Effect.tap((canonicalEvent) =>
        canonicalEventLogger ? canonicalEventLogger.write(canonicalEvent, null) : Effect.void,
      ),
      Effect.flatMap((canonicalEvent) => PubSub.publish(runtimeEventPubSub, canonicalEvent)),
      Effect.asVoid,
    );

  const upsertSessionBinding = makeUpsertSessionBinding(directory);

  const providers = yield* registry.listProviders();
  const adapters = yield* Effect.forEach(providers, (provider) => registry.getByProvider(provider));
  const processRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    increment(providerRuntimeEventsTotal, {
      provider: event.provider,
      eventType: event.type,
    }).pipe(Effect.andThen(publishRuntimeEvent(event)));

  yield* Effect.forEach(adapters, (adapter) =>
    Stream.runForEach(adapter.streamEvents, processRuntimeEvent).pipe(Effect.forkScoped),
  ).pipe(Effect.asVoid);

  // Build session routing helpers
  const recoverSessionForThread = makeRecoverSessionForThread(
    registry,
    directory,
    upsertSessionBinding,
    analytics,
  );
  const resolveRoutableSession = makeResolveRoutableSession(
    registry,
    directory,
    recoverSessionForThread,
  );

  const stopStaleSessionsForThread = makeStopStaleSessionsForThread(adapters, analytics);

  const startSessionInternal = (options?: {
    readonly reusePersistedResumeCursor?: boolean;
  }): ProviderServiceShape["startSession"] =>
    Effect.fn("startSession")(function* (threadId, rawInput) {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderService.startSession",
        schema: ProviderSessionStartInput,
        payload: rawInput,
      });
      const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));

      const provider = parsed.provider ?? "codex";
      const workspaceDefaultExecutionTargetId =
        persistedBinding?.workspaceExecutionTargetId ??
        persistedBinding?.executionTargetId ??
        LOCAL_EXECUTION_TARGET_ID;
      const input = {
        ...parsed,
        threadId,
        provider,
        ...resolveProviderSessionExecutionTargets({
          providerRuntimeExecutionTargetId: parsed.providerRuntimeExecutionTargetId,
          workspaceExecutionTargetId: parsed.workspaceExecutionTargetId,
          executionTargetId: parsed.executionTargetId,
          useLegacyExecutionTargetForProviderRuntime:
            !getProviderCapabilities(provider).supportsLocalRuntimeRemoteWorkspace,
          defaultProviderRuntimeExecutionTargetId: getProviderCapabilities(provider)
            .supportsLocalRuntimeRemoteWorkspace
            ? LOCAL_EXECUTION_TARGET_ID
            : (persistedBinding?.providerRuntimeExecutionTargetId ??
              persistedBinding?.executionTargetId ??
              workspaceDefaultExecutionTargetId),
          defaultWorkspaceExecutionTargetId: workspaceDefaultExecutionTargetId,
        }),
      };
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "start-session",
        "provider.kind": input.provider,
        "provider.thread_id": threadId,
        "provider.runtime_mode": input.runtimeMode,
      });
      return yield* Effect.gen(function* () {
        if (
          !supportsProviderExecutionTarget({
            provider: input.provider,
            executionTargetId: input.providerRuntimeExecutionTargetId,
          })
        ) {
          return yield* toValidationError(
            "ProviderService.startSession",
            formatUnsupportedProviderExecutionTargetDetail({
              provider: input.provider,
              executionTargetId: input.providerRuntimeExecutionTargetId,
              surface: "Provider sessions",
            }),
          );
        }
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError((error) =>
            toValidationError(
              "ProviderService.startSession",
              `Failed to load provider settings: ${error.message}`,
              error,
            ),
          ),
        );
        if (!settings.providers[input.provider].enabled) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider '${input.provider}' is disabled in bigbud settings.`,
          );
        }
        const effectiveResumeCursor =
          input.resumeCursor ??
          (options?.reusePersistedResumeCursor !== false &&
          persistedBinding?.provider === input.provider
            ? persistedBinding.resumeCursor
            : undefined);
        const adapter = yield* registry.getByProvider(input.provider);
        const session = yield* adapter.startSession({
          ...input,
          ...(effectiveResumeCursor !== undefined ? { resumeCursor: effectiveResumeCursor } : {}),
        });

        if (session.provider !== adapter.provider) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
          );
        }

        yield* stopStaleSessionsForThread({
          threadId,
          currentProvider: adapter.provider,
        });
        yield* upsertSessionBinding(session, threadId, { modelSelection: input.modelSelection });
        yield* analytics.record("provider.session.started", {
          provider: session.provider,
          runtimeMode: input.runtimeMode,
          hasResumeCursor: session.resumeCursor !== undefined,
          hasCwd: typeof input.cwd === "string" && input.cwd.trim().length > 0,
          hasModel:
            typeof input.modelSelection?.model === "string" &&
            input.modelSelection.model.trim().length > 0,
        });

        return session;
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          attributes: providerMetricAttributes(input.provider, { operation: "start" }),
        }),
      );
    });

  const startSession: ProviderServiceShape["startSession"] = startSessionInternal();
  const startSessionFresh: ProviderServiceShape["startSessionFresh"] = startSessionInternal({
    reusePersistedResumeCursor: false,
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
      });
      metricProvider = routed.adapter.provider;
      metricModel = input.modelSelection?.model;
      yield* Effect.annotateCurrentSpan({
        "provider.kind": routed.adapter.provider,
        ...(input.modelSelection?.model ? { "provider.model": input.modelSelection.model } : {}),
      });
      const turn = yield* routed.adapter.sendTurn(input);
      yield* directory.upsert({
        threadId: input.threadId,
        provider: routed.adapter.provider,
        status: "running",
        ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
        runtimePayload: {
          ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
          activeTurnId: turn.turnId,
          lastRuntimeEvent: "provider.sendTurn",
          lastRuntimeEventAt: new Date().toISOString(),
        },
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

  const interruptTurn: ProviderServiceShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.interruptTurn",
        schema: ProviderInterruptTurnInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.interruptTurn",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "interrupt-turn",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.turn_id": input.turnId,
        });
        yield* routed.adapter.interruptTurn(routed.threadId, input.turnId);
        yield* analytics.record("provider.turn.interrupted", { provider: routed.adapter.provider });
      }).pipe(
        Effect.mapError((e) => e as ProviderServiceError),
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, { operation: "interrupt" }),
        }),
      );
    },
  );

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

  const listSessions: ProviderServiceShape["listSessions"] = makeListSessions(adapters, directory);

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
    startSession,
    startSessionFresh,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    getCapabilities,
    rollbackConversation,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (ProviderRuntimeIngestion, CheckpointReactor, etc.) each
    // independently receive all runtime events.
    get streamEvents(): ProviderServiceShape["streamEvents"] {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  } satisfies ProviderServiceShape;
});

export const ProviderServiceLive = Layer.effect(ProviderService, makeProviderService());

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService, makeProviderService(options));
}
