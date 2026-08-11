import type { ServerProvider } from "@bigbud/contracts";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";

import type { ServerProviderRecoveryOptions } from "./Services/ServerProvider";
import { isProviderRetryable, isProviderStartupRetryable } from "./providerRecovery";

export const STARTUP_FOREGROUND_ATTEMPTS = 2;
export const STARTUP_RECOVERY_MAX_ATTEMPTS = 5;
export const STARTUP_FOREGROUND_DELAYS = ["1 second"] as const;
export const BACKGROUND_RECOVERY_DELAYS = ["3 seconds", "8 seconds", "20 seconds"] as const;
export const DEFAULT_PERIODIC_HEALTH_INTERVAL = "5 minutes";
export const STARTUP_RECOVERY_OPERATION_ID = randomUUID();

export function logStartupSuperseded(
  provider: ServerProvider["provider"],
  trigger: "startup" | "background",
  generation: number,
) {
  return Effect.logInfo("provider recovery superseded", {
    provider,
    trigger,
    generation,
    operationId: STARTUP_RECOVERY_OPERATION_ID,
  });
}

export function withProviderRecovery(
  snapshot: ServerProvider,
  recovery: ServerProviderRecoveryOptions,
  generation: number,
): ServerProvider {
  if (!snapshot.enabled) return snapshot;
  if (snapshot.failure === undefined && recovery.attempt === 1 && recovery.trigger === "startup") {
    return snapshot;
  }
  const retryable =
    recovery.trigger !== "manual"
      ? isProviderStartupRetryable(snapshot)
      : isProviderRetryable(snapshot);
  return {
    ...snapshot,
    recovery: {
      ...recovery,
      operationId: recovery.operationId ?? `${snapshot.provider}:${recovery.trigger}:${generation}`,
      generation,
      status:
        snapshot.failure === undefined
          ? "recovered"
          : retryable && recovery.attempt < recovery.maxAttempts
            ? "retrying"
            : "exhausted",
    },
  };
}
