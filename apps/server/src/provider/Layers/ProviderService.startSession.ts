import {
  LOCAL_EXECUTION_TARGET_ID,
  ProviderSessionStartInput,
  type ProviderSession,
  type ThreadId,
} from "@bigbud/contracts";
import { Duration, Effect, Exit, Option } from "effect";

import {
  providerMetricAttributes,
  providerSessionsTotal,
  withMetrics,
} from "../../observability/Metrics.ts";
import type { AnalyticsServiceShape } from "../../telemetry/Services/AnalyticsService.ts";
import type { ProviderServiceError } from "../Errors.ts";
import type { ProviderAdapterRegistryShape } from "../Services/ProviderAdapterRegistry.ts";
import type { ProviderSessionDirectoryShape } from "../Services/ProviderSessionDirectory.ts";
import type { ProviderSessionDirectoryWriteError } from "../Services/ProviderSessionDirectory.ts";
import type { ProviderServiceShape } from "../Services/ProviderService.ts";
import type { ProviderCapabilitiesResolver } from "../providerCapabilities.ts";
import {
  formatUnsupportedProviderExecutionTargetDetail,
  formatUnsupportedProviderLocalRuntimeRemoteWorkspaceDetail,
  isUnsupportedProviderLocalRuntimeRemoteWorkspace,
  supportsProviderExecutionTarget,
} from "../providerExecutionTargets.ts";
import { resolveProviderSessionExecutionTargets } from "../providerSessionExecutionTargets.ts";
import { decodeInputOrValidationError, toValidationError } from "./ProviderServiceHelpers.ts";

const PROVIDER_SESSION_START_TIMEOUT = Duration.seconds(45);

type UpsertSessionBinding = (
  session: ProviderSession,
  threadId: ThreadId,
  extra?: {
    readonly modelSelection?: unknown;
  },
) => Effect.Effect<void, ProviderSessionDirectoryWriteError>;

export function makeStartSessionInternal(input: {
  readonly registry: ProviderAdapterRegistryShape;
  readonly directory: ProviderSessionDirectoryShape;
  readonly upsertSessionBinding: UpsertSessionBinding;
  readonly analytics: AnalyticsServiceShape;
  readonly serverSettings: {
    readonly getSettings: Effect.Effect<
      {
        readonly providers: Record<string, { readonly enabled: boolean }>;
      },
      Error
    >;
  };
  readonly getProviderCapabilities: ProviderCapabilitiesResolver;
  readonly isProviderComposed: (provider: ProviderSession["provider"]) => boolean;
  readonly stopStaleSessionsForThread: (args: {
    readonly threadId: ThreadId;
    readonly currentProvider: ProviderSession["provider"];
  }) => Effect.Effect<void>;
  readonly options?: {
    readonly reusePersistedResumeCursor?: boolean;
  };
}): ProviderServiceShape["startSession"] {
  return Effect.fn("startSession")(function* (threadId, rawInput): Effect.fn.Return<
    ProviderSession,
    ProviderServiceError
  > {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.startSession",
      schema: ProviderSessionStartInput,
      payload: rawInput,
    });
    if (
      parsed.provider !== undefined &&
      parsed.modelSelection?.provider !== undefined &&
      parsed.provider !== parsed.modelSelection.provider
    ) {
      return yield* toValidationError(
        "ProviderService.startSession",
        `Provider '${parsed.provider}' does not match modelSelection provider '${parsed.modelSelection.provider}'.`,
      );
    }
    const provider = parsed.provider ?? parsed.modelSelection?.provider ?? "codex";
    if (!input.isProviderComposed(provider)) {
      return yield* toValidationError(
        "ProviderService.startSession",
        `Provider '${provider}' is unavailable in this bigbud build.`,
      );
    }

    const capabilities = input.getProviderCapabilities(provider);
    const persistedBinding = Option.getOrUndefined(yield* input.directory.getBinding(threadId));
    const workspaceDefaultExecutionTargetId =
      persistedBinding?.workspaceExecutionTargetId ??
      persistedBinding?.executionTargetId ??
      LOCAL_EXECUTION_TARGET_ID;
    const startInput = {
      ...parsed,
      threadId,
      provider,
      ...resolveProviderSessionExecutionTargets({
        providerRuntimeExecutionTargetId: parsed.providerRuntimeExecutionTargetId,
        workspaceExecutionTargetId: parsed.workspaceExecutionTargetId,
        executionTargetId: parsed.executionTargetId,
        useLegacyExecutionTargetForProviderRuntime:
          !capabilities.supportsLocalRuntimeRemoteWorkspace,
        defaultProviderRuntimeExecutionTargetId: capabilities.supportsLocalRuntimeRemoteWorkspace
          ? LOCAL_EXECUTION_TARGET_ID
          : (persistedBinding?.providerRuntimeExecutionTargetId ??
            persistedBinding?.executionTargetId ??
            workspaceDefaultExecutionTargetId),
        defaultWorkspaceExecutionTargetId: workspaceDefaultExecutionTargetId,
      }),
    };

    yield* Effect.annotateCurrentSpan({
      "provider.operation": "start-session",
      "provider.kind": startInput.provider,
      "provider.thread_id": threadId,
      "provider.runtime_mode": startInput.runtimeMode,
    });

    return yield* Effect.gen(function* () {
      if (
        isUnsupportedProviderLocalRuntimeRemoteWorkspace({
          provider: startInput.provider,
          providerRuntimeExecutionTargetId: startInput.providerRuntimeExecutionTargetId,
          workspaceExecutionTargetId: startInput.workspaceExecutionTargetId,
        })
      ) {
        return yield* toValidationError(
          "ProviderService.startSession",
          formatUnsupportedProviderLocalRuntimeRemoteWorkspaceDetail({
            provider: startInput.provider,
            workspaceExecutionTargetId: startInput.workspaceExecutionTargetId,
          }),
        );
      }
      if (
        !supportsProviderExecutionTarget(
          {
            provider: startInput.provider,
            executionTargetId: startInput.providerRuntimeExecutionTargetId,
          },
          input.getProviderCapabilities,
        )
      ) {
        return yield* toValidationError(
          "ProviderService.startSession",
          formatUnsupportedProviderExecutionTargetDetail({
            provider: startInput.provider,
            executionTargetId: startInput.providerRuntimeExecutionTargetId,
            surface: "Provider sessions",
          }),
        );
      }

      const settings = yield* input.serverSettings.getSettings.pipe(
        Effect.mapError((error) =>
          toValidationError(
            "ProviderService.startSession",
            `Failed to load provider settings: ${error.message}`,
            error,
          ),
        ),
      );
      const providerSettings = settings.providers[startInput.provider];
      if (!providerSettings?.enabled) {
        return yield* toValidationError(
          "ProviderService.startSession",
          `Provider '${startInput.provider}' is disabled in bigbud settings.`,
        );
      }

      const adapter = yield* input.registry.getByProvider(startInput.provider);
      const recoveryMode = adapter.capabilities.sessionRecovery;
      const recoveryUnsupported = recoveryMode === "unsupported";
      if (startInput.resumeCursor !== undefined && recoveryUnsupported) {
        return yield* toValidationError(
          "ProviderService.startSession",
          `Provider '${startInput.provider}' does not support session recovery.`,
        );
      }
      const effectiveResumeCursor =
        recoveryMode === "fresh-restart"
          ? undefined
          : (startInput.resumeCursor ??
            (!recoveryUnsupported &&
            input.options?.reusePersistedResumeCursor !== false &&
            persistedBinding?.provider === startInput.provider
              ? persistedBinding.resumeCursor
              : undefined));
      let admitted = false;
      let adapterAttempted = false;
      const restoreBinding = persistedBinding
        ? input.directory.upsert(persistedBinding)
        : input.directory.remove(threadId);
      const rollbackStart = Effect.gen(function* () {
        const stopExit = adapterAttempted
          ? yield* Effect.exit(adapter.stopSession(threadId))
          : Exit.void;
        const restoreExit = admitted ? yield* Effect.exit(restoreBinding) : Exit.void;
        if (Exit.isFailure(stopExit)) {
          yield* Effect.logWarning("provider session rollback stop failed", {
            provider: startInput.provider,
            threadId,
            cause: stopExit.cause,
          });
        }
        if (Exit.isFailure(restoreExit)) {
          yield* Effect.logWarning("provider session rollback binding restore failed", {
            provider: startInput.provider,
            threadId,
            cause: restoreExit.cause,
          });
        }
      });

      return yield* Effect.gen(function* () {
        yield* input.directory.upsert({
          threadId,
          provider: startInput.provider,
          providerRuntimeExecutionTargetId: startInput.providerRuntimeExecutionTargetId,
          workspaceExecutionTargetId: startInput.workspaceExecutionTargetId,
          executionTargetId: startInput.executionTargetId,
          runtimeMode: startInput.runtimeMode,
          status: "starting",
          runtimePayload: {
            ...(startInput.sessionEpoch !== undefined
              ? { sessionEpoch: startInput.sessionEpoch }
              : {}),
            ...(startInput.cwd ? { cwd: startInput.cwd } : {}),
            ...(startInput.modelSelection ? { modelSelection: startInput.modelSelection } : {}),
            lastRuntimeEvent: "provider.startSession.admitted",
            lastRuntimeEventAt: new Date().toISOString(),
          },
        });
        admitted = true;
        adapterAttempted = true;
        const sessionOption = yield* adapter
          .startSession({
            ...startInput,
            ...(effectiveResumeCursor !== undefined ? { resumeCursor: effectiveResumeCursor } : {}),
          })
          .pipe(Effect.timeoutOption(PROVIDER_SESSION_START_TIMEOUT));
        const adapterSession =
          Option.getOrUndefined(sessionOption) ??
          (yield* toValidationError(
            "ProviderService.startSession",
            `Provider '${startInput.provider}' session startup timed out after ${Duration.toSeconds(PROVIDER_SESSION_START_TIMEOUT)}s before the first turn could be sent.`,
          ));
        if (adapterSession.provider !== adapter.provider) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Adapter/provider mismatch: requested '${adapter.provider}', received '${adapterSession.provider}'.`,
          );
        }
        const session: ProviderSession = {
          ...adapterSession,
          ...(startInput.sessionEpoch !== undefined
            ? { sessionEpoch: startInput.sessionEpoch }
            : {}),
        };

        yield* input.stopStaleSessionsForThread({
          threadId,
          currentProvider: adapter.provider,
        });
        yield* input.upsertSessionBinding(session, threadId, {
          modelSelection: startInput.modelSelection,
        });
        yield* input.analytics.record("provider.session.started", {
          provider: session.provider,
          runtimeMode: startInput.runtimeMode,
          hasResumeCursor: session.resumeCursor !== undefined,
          hasCwd: typeof startInput.cwd === "string" && startInput.cwd.trim().length > 0,
          hasModel:
            typeof startInput.modelSelection?.model === "string" &&
            startInput.modelSelection.model.trim().length > 0,
        });

        return session;
      }).pipe(Effect.onError(() => rollbackStart.pipe(Effect.orDie)));
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: providerMetricAttributes(startInput.provider, { operation: "start" }),
      }),
      Effect.mapError((error) => error as ProviderServiceError),
    );
  });
}
