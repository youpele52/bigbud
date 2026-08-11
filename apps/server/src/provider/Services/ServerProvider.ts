import type { ServerProvider } from "@bigbud/contracts";
import type { Effect, Stream } from "effect";

export interface ServerProviderRecoveryOptions {
  readonly operationId?: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly trigger: "startup" | "background" | "manual";
}

export interface ServerProviderShape {
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly refresh: Effect.Effect<ServerProvider>;
  readonly refreshWithRecovery: (
    options: ServerProviderRecoveryOptions,
  ) => Effect.Effect<ServerProvider>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
}
