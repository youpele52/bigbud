import type { ProviderKind, ServerDiscoveryCatalog } from "@bigbud/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

export interface DiscoveryRegistryShape {
  readonly getCatalog: Effect.Effect<ServerDiscoveryCatalog>;
  readonly refresh: (provider?: ProviderKind) => Effect.Effect<ServerDiscoveryCatalog>;
  readonly streamChanges: Stream.Stream<ServerDiscoveryCatalog>;
}

export class DiscoveryRegistry extends ServiceMap.Service<
  DiscoveryRegistry,
  DiscoveryRegistryShape
>()("t3/provider/Services/DiscoveryRegistry") {}
