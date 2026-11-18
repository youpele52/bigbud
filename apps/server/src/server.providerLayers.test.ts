import type { Layer } from "effect";
import { expectTypeOf, it } from "vitest";

import type { ProviderSessionRuntimeRepository } from "./persistence/Services/ProviderSessionRuntime.ts";
import type { makeProviderInfrastructureLayerLive } from "./server.providerLayers.ts";

type Provided = Layer.Success<ReturnType<typeof makeProviderInfrastructureLayerLive>>;

it("exports the provider runtime repository for runtime ingestion's startup hygiene", () => {
  // Ingestion reads it with `Effect.serviceOption`; if it is only provided to the session
  // directory, the startup reconcile of stale `running` rows silently never runs (F-M3-2).
  expectTypeOf<Extract<Provided, ProviderSessionRuntimeRepository>>().not.toBeNever();
});
