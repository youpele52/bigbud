import type { ServerProvider, ServerProviderModel } from "@bigbud/contracts";
import type { SubscriptionRefreshOutcome } from "@bigbud/contracts/server/usageLimits.ts";
import type { Effect, Stream } from "effect";

export interface ProviderUsageReadResult {
  readonly snapshot: ServerProvider;
  readonly status: Exclude<SubscriptionRefreshOutcome["status"], "timed-out">;
}

export interface ServerProviderRecoveryOptions {
  readonly operationId?: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly trigger: "startup" | "background" | "manual";
}

export interface ServerProviderShape {
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  /** Cache-only lookup for providers with Location-specific capabilities; undefined on a miss. */
  readonly getWorkspaceModels?: (
    directory: string,
  ) => ReadonlyArray<ServerProviderModel> | undefined;
  readonly refresh: Effect.Effect<ServerProvider>;
  /** Optional read-only quota probe, without provider recovery or model discovery. */
  readonly refreshUsageLimits?: Effect.Effect<ProviderUsageReadResult>;
  readonly refreshWithRecovery: (
    options: ServerProviderRecoveryOptions,
  ) => Effect.Effect<ServerProvider>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
}
