/**
 * ProviderRegistry - Provider snapshot service.
 *
 * Owns provider install/auth/version/model snapshots and exposes the latest
 * provider state to transport layers.
 *
 * @module ProviderRegistry
 */
import type { ProviderKind, ServerProvider } from "@bigbud/contracts";
import { ServiceMap } from "effect";
import type { Effect, Option, Stream } from "effect";

export interface ProviderRegistryShape {
  /**
   * Read the latest provider snapshots.
   */
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Refresh all providers, or a single provider when specified.
   */
  readonly refresh: (provider?: ProviderKind) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Stream of provider snapshot updates.
   */
  readonly streamChanges: Stream.Stream<ReadonlyArray<ServerProvider>>;

  /**
   * Await the first provider that reaches `status: "ready"` after startup.
   * Resolves with `Some(provider)` when the first ready provider is latched,
   * or `None` if no provider becomes ready within the timeout.
   */
  readonly awaitFirstReadyProvider: Effect.Effect<Option.Option<ServerProvider>>;
}

export class ProviderRegistry extends ServiceMap.Service<ProviderRegistry, ProviderRegistryShape>()(
  "t3/provider/Services/ProviderRegistry",
) {}
