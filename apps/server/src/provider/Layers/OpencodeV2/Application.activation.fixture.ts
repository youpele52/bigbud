import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeV2ApplicationRegistration } from "./Application.composition.ts";
import { ThreadToolsActivationLive } from "./ThreadToolsActivation.ts";
import { composeOptionalProviders } from "../OptionalProviderComposition.ts";
import { ThreadToolsActivation } from "../../Services/OpencodeV2/ThreadToolsActivation.ts";
import { V2ThreadToolsActivation } from "./PluginSetup.activation.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import type { V2NativeEligibilityVerifier } from "./NativeCompatibility.runtime.ts";

/** Fixture-only resolver injection; production root layer always composes the completed registry. */
function candidateActivationLayer(eligibility: V2NativeEligibilityVerifier) {
  return Layer.effect(
    ThreadToolsActivation,
    Effect.gen(function* () {
      const activation = new V2ThreadToolsActivation(yield* ServerSettingsService, eligibility);
      yield* Effect.addFinalizer(() => Effect.promise(() => activation.close()));
      return activation;
    }),
  );
}

/** Standalone owned test scopes explicitly supply the same service production receives from the root layer. */
export const makeV2ActivatedFixtureRegistration = Effect.fn("makeV2ActivatedFixtureRegistration")(
  function* (eligibility?: V2NativeEligibilityVerifier) {
    const services = yield* Layer.build(
      eligibility ? candidateActivationLayer(eligibility) : ThreadToolsActivationLive,
    );
    return yield* makeV2ApplicationRegistration().pipe(Effect.provide(services));
  },
);
export const composeActivatedFixtureProviders = Effect.fn("composeActivatedFixtureProviders")(
  function* (...args: Parameters<typeof composeOptionalProviders>) {
    const services = yield* Layer.build(ThreadToolsActivationLive);
    return yield* composeOptionalProviders(...args).pipe(Effect.provide(services));
  },
);
