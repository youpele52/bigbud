import {
  LOCAL_EXECUTION_TARGET_ID,
  ProviderSessionStartInput,
  type ProviderSession,
  type ThreadId,
} from "@bigbud/contracts";
import { Effect, Option } from "effect";

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
import { getProviderCapabilities } from "../providerCapabilities.ts";
import {
  formatUnsupportedProviderExecutionTargetDetail,
  supportsProviderExecutionTarget,
} from "../providerExecutionTargets.ts";
import { resolveProviderSessionExecutionTargets } from "../providerSessionExecutionTargets.ts";
import { decodeInputOrValidationError, toValidationError } from "./ProviderServiceHelpers.ts";

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
    const persistedBinding = Option.getOrUndefined(yield* input.directory.getBinding(threadId));

    const provider = parsed.provider ?? "codex";
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
      "provider.kind": startInput.provider,
      "provider.thread_id": threadId,
      "provider.runtime_mode": startInput.runtimeMode,
    });

    return yield* Effect.gen(function* () {
      if (
        !supportsProviderExecutionTarget({
          provider: startInput.provider,
          executionTargetId: startInput.providerRuntimeExecutionTargetId,
        })
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

      const effectiveResumeCursor =
        startInput.resumeCursor ??
        (input.options?.reusePersistedResumeCursor !== false &&
        persistedBinding?.provider === startInput.provider
          ? persistedBinding.resumeCursor
          : undefined);
      const adapter = yield* input.registry.getByProvider(startInput.provider);
      const session = yield* adapter.startSession({
        ...startInput,
        ...(effectiveResumeCursor !== undefined ? { resumeCursor: effectiveResumeCursor } : {}),
      });

      if (session.provider !== adapter.provider) {
        return yield* toValidationError(
          "ProviderService.startSession",
          `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
        );
      }

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
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: providerMetricAttributes(startInput.provider, { operation: "start" }),
      }),
      Effect.mapError((error) => error as ProviderServiceError),
    );
  });
}
