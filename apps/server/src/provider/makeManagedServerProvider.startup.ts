import type { ServerProvider } from "@bigbud/contracts";
import { ServerSettingsError } from "@bigbud/contracts";
import { Effect, Ref } from "effect";

import type { ServerProviderRecoveryOptions } from "./Services/ServerProvider";
import { isProviderStartupRetryable } from "./providerRecovery";
import {
  BACKGROUND_RECOVERY_DELAYS,
  logStartupSuperseded,
  STARTUP_FOREGROUND_ATTEMPTS,
  STARTUP_FOREGROUND_DELAYS,
  STARTUP_RECOVERY_MAX_ATTEMPTS,
  STARTUP_RECOVERY_OPERATION_ID,
} from "./managedProviderRecovery";

export const runManagedProviderStartupRecovery = Effect.fn("runManagedProviderStartupRecovery")(
  function* (input: {
    readonly enabled: boolean;
    readonly provider: ServerProvider["provider"];
    readonly startupGeneration: number;
    readonly generationRef: Ref.Ref<number>;
    readonly hasStartupProbe: boolean;
    readonly hasEnrichment: boolean;
    readonly refreshSnapshot: (options?: {
      readonly recovery?: ServerProviderRecoveryOptions;
      readonly generation?: number;
      readonly probeMode?: "startup" | "full";
    }) => Effect.Effect<ServerProvider, ServerSettingsError>;
  }) {
    if (!input.enabled) return;
    yield* Effect.logInfo("provider recovery operation started", {
      provider: input.provider,
      trigger: "startup",
      generation: input.startupGeneration,
      operationId: STARTUP_RECOVERY_OPERATION_ID,
      maxAttempts: STARTUP_RECOVERY_MAX_ATTEMPTS,
    });
    for (let attempt = 1; attempt <= STARTUP_FOREGROUND_ATTEMPTS; attempt += 1) {
      const snapshot = yield* input.refreshSnapshot({
        recovery: {
          operationId: STARTUP_RECOVERY_OPERATION_ID,
          attempt,
          maxAttempts: STARTUP_RECOVERY_MAX_ATTEMPTS,
          trigger: "startup",
        },
        generation: input.startupGeneration,
        probeMode: "startup",
      });
      if (input.startupGeneration !== (yield* Ref.get(input.generationRef))) {
        yield* logStartupSuperseded(input.provider, "startup", input.startupGeneration);
        return;
      }
      if (!isProviderStartupRetryable(snapshot)) {
        const settledSnapshot =
          snapshot.status === "ready" && input.hasStartupProbe && !input.hasEnrichment
            ? yield* input.refreshSnapshot({
                recovery: {
                  operationId: STARTUP_RECOVERY_OPERATION_ID,
                  attempt: STARTUP_FOREGROUND_ATTEMPTS,
                  maxAttempts: STARTUP_RECOVERY_MAX_ATTEMPTS,
                  trigger: "startup",
                },
                generation: input.startupGeneration,
                probeMode: "full",
              })
            : snapshot;
        if (isProviderStartupRetryable(settledSnapshot)) break;
        yield* Effect.logInfo("provider recovery completed", {
          provider: input.provider,
          trigger: "startup",
          generation: input.startupGeneration,
          operationId: STARTUP_RECOVERY_OPERATION_ID,
          outcome: settledSnapshot.status === "ready" ? "recovered" : "user-action-required",
        });
        return;
      }
      if (attempt === STARTUP_FOREGROUND_ATTEMPTS) break;
      const delay = STARTUP_FOREGROUND_DELAYS[attempt - 1]!;
      yield* Effect.logInfo("provider recovery retry scheduled", {
        provider: input.provider,
        trigger: "startup",
        generation: input.startupGeneration,
        operationId: STARTUP_RECOVERY_OPERATION_ID,
        attempt,
        delay,
      });
      yield* Effect.sleep(delay);
      if (input.startupGeneration !== (yield* Ref.get(input.generationRef))) {
        yield* logStartupSuperseded(input.provider, "startup", input.startupGeneration);
        return;
      }
    }

    yield* Effect.logInfo("provider recovery moved to background", {
      provider: input.provider,
      trigger: "background",
      generation: input.startupGeneration,
      operationId: STARTUP_RECOVERY_OPERATION_ID,
    });
    for (let index = 0; index < BACKGROUND_RECOVERY_DELAYS.length; index += 1) {
      const attempt = STARTUP_FOREGROUND_ATTEMPTS + index + 1;
      const delay = BACKGROUND_RECOVERY_DELAYS[index]!;
      yield* Effect.logInfo("provider recovery retry scheduled", {
        provider: input.provider,
        trigger: "background",
        generation: input.startupGeneration,
        operationId: STARTUP_RECOVERY_OPERATION_ID,
        attempt,
        delay,
      });
      yield* Effect.sleep(delay);
      if (input.startupGeneration !== (yield* Ref.get(input.generationRef))) {
        yield* logStartupSuperseded(input.provider, "background", input.startupGeneration);
        return;
      }
      const snapshot = yield* input.refreshSnapshot({
        recovery: {
          operationId: STARTUP_RECOVERY_OPERATION_ID,
          attempt,
          maxAttempts: STARTUP_RECOVERY_MAX_ATTEMPTS,
          trigger: "background",
        },
        generation: input.startupGeneration,
        probeMode: "full",
      });
      if (input.startupGeneration !== (yield* Ref.get(input.generationRef))) {
        yield* logStartupSuperseded(input.provider, "background", input.startupGeneration);
        return;
      }
      if (!isProviderStartupRetryable(snapshot)) {
        yield* Effect.logInfo("provider recovery completed", {
          provider: input.provider,
          trigger: "background",
          generation: input.startupGeneration,
          operationId: STARTUP_RECOVERY_OPERATION_ID,
          outcome: snapshot.status === "ready" ? "recovered" : "user-action-required",
        });
        return;
      }
      if (attempt === STARTUP_RECOVERY_MAX_ATTEMPTS) {
        yield* Effect.logWarning("provider recovery exhausted", {
          provider: input.provider,
          trigger: "background",
          generation: input.startupGeneration,
          operationId: STARTUP_RECOVERY_OPERATION_ID,
          classification: snapshot.failure?.classification ?? "none",
          reason: snapshot.failure?.reason ?? "none",
        });
      }
    }
  },
);
