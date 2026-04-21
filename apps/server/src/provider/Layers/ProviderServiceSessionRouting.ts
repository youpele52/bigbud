/**
 * Session routing helpers for ProviderService.
 *
 * Extracted from ProviderService.ts to keep that file under 500 lines.
 * `makeRecoverSessionForThread` and `makeResolveRoutableSession` are curried
 * factory functions that accept the services they depend on.
 */
import { type ProviderSession, ThreadId } from "@bigbud/contracts";
import { Effect, Option } from "effect";

import {
  providerMetricAttributes,
  providerSessionsTotal,
  withMetrics,
} from "../../observability/Metrics.ts";
import type { AnalyticsServiceShape } from "../../telemetry/Services/AnalyticsService.ts";
import type { ProviderAdapterRegistryShape } from "../Services/ProviderAdapterRegistry.ts";
import type {
  ProviderRuntimeBinding,
  ProviderSessionDirectoryShape,
} from "../Services/ProviderSessionDirectory.ts";
import type { ProviderServiceError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  toValidationError,
  readPersistedCwd,
  readPersistedModelSelection,
} from "./ProviderServiceHelpers.ts";

export function makeRecoverSessionForThread(
  registry: ProviderAdapterRegistryShape,
  directory: ProviderSessionDirectoryShape,
  upsertSessionBinding: (
    session: ProviderSession,
    threadId: ThreadId,
    extra?: {
      readonly modelSelection?: unknown;
      readonly lastRuntimeEvent?: string;
      readonly lastRuntimeEventAt?: string;
    },
  ) => Effect.Effect<void, ProviderServiceError>,
  analytics: AnalyticsServiceShape,
) {
  return Effect.fn("recoverSessionForThread")(function* (input: {
    readonly binding: ProviderRuntimeBinding;
    readonly operation: string;
  }): Effect.fn.Return<
    {
      readonly adapter: ProviderAdapterShape<ProviderServiceError>;
      readonly session: ProviderSession;
    },
    ProviderServiceError
  > {
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "recover-session",
      "provider.kind": input.binding.provider,
      "provider.thread_id": input.binding.threadId,
    });
    return yield* Effect.gen(function* () {
      const adapterRaw = yield* registry.getByProvider(input.binding.provider);
      const adapter = adapterRaw as unknown as ProviderAdapterShape<ProviderServiceError>;
      const hasResumeCursor =
        input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined;
      const hasActiveSession = yield* adapter.hasSession(input.binding.threadId);
      if (hasActiveSession) {
        const activeSessions = yield* adapter.listSessions();
        const existing = activeSessions.find(
          (session) => session.threadId === input.binding.threadId,
        );
        if (existing) {
          yield* upsertSessionBinding(existing, input.binding.threadId);
          yield* analytics.record("provider.session.recovered", {
            provider: existing.provider,
            strategy: "adopt-existing",
            hasResumeCursor: existing.resumeCursor !== undefined,
          });
          return { adapter, session: existing } as const;
        }
      }

      if (!hasResumeCursor) {
        return yield* toValidationError(
          input.operation,
          `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
        );
      }

      const persistedCwd = readPersistedCwd(input.binding.runtimePayload);
      const persistedModelSelection = readPersistedModelSelection(input.binding.runtimePayload);

      const resumed = yield* adapter.startSession({
        threadId: input.binding.threadId,
        provider: input.binding.provider,
        ...(persistedCwd ? { cwd: persistedCwd } : {}),
        ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
        ...(hasResumeCursor ? { resumeCursor: input.binding.resumeCursor } : {}),
        runtimeMode: input.binding.runtimeMode ?? "full-access",
      });
      if (resumed.provider !== adapter.provider) {
        return yield* toValidationError(
          input.operation,
          `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
        );
      }

      yield* upsertSessionBinding(resumed, input.binding.threadId);
      yield* analytics.record("provider.session.recovered", {
        provider: resumed.provider,
        strategy: "resume-thread",
        hasResumeCursor: resumed.resumeCursor !== undefined,
      });
      return {
        adapter: adapter as ProviderAdapterShape<ProviderServiceError>,
        session: resumed,
      } as const;
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: providerMetricAttributes(input.binding.provider, { operation: "recover" }),
      }),
      Effect.mapError((e) => e as ProviderServiceError),
    );
  });
}

export function makeResolveRoutableSession(
  registry: ProviderAdapterRegistryShape,
  directory: ProviderSessionDirectoryShape,
  recoverSessionForThread: (input: {
    readonly binding: ProviderRuntimeBinding;
    readonly operation: string;
  }) => Effect.Effect<
    {
      readonly adapter: ProviderAdapterShape<ProviderServiceError>;
      readonly session: ProviderSession;
    },
    ProviderServiceError
  >,
) {
  return Effect.fn("resolveRoutableSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
    readonly allowRecovery: boolean;
  }): Effect.fn.Return<
    {
      readonly adapter: ProviderAdapterShape<ProviderServiceError>;
      readonly threadId: ThreadId;
      readonly isActive: boolean;
    },
    ProviderServiceError
  > {
    const bindingOption = yield* directory.getBinding(input.threadId);
    const binding = Option.getOrUndefined(bindingOption);
    if (!binding) {
      return yield* toValidationError(
        input.operation,
        `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
      );
    }
    const adapterRaw = yield* registry
      .getByProvider(binding.provider)
      .pipe(Effect.mapError((e) => e as ProviderServiceError));
    const adapter = adapterRaw as unknown as ProviderAdapterShape<ProviderServiceError>;

    const hasRequestedSession = yield* adapter.hasSession(input.threadId);
    if (hasRequestedSession) {
      return { adapter, threadId: input.threadId, isActive: true } as const;
    }

    if (!input.allowRecovery) {
      return { adapter, threadId: input.threadId, isActive: false } as const;
    }

    const recovered = yield* recoverSessionForThread({ binding, operation: input.operation }).pipe(
      Effect.mapError((e) => e as ProviderServiceError),
    );
    return { adapter: recovered.adapter, threadId: input.threadId, isActive: true } as const;
  });
}
