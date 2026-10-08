import { Effect, Layer } from "effect";

import {
  OptionalProviderRegistrations,
  type OptionalProviderRegistration,
} from "../ProviderRegistration.ts";
import { CliProxyCompositionLive } from "./CliProxy/Composition.ts";
import { makeDormantOpencodeV2Adapter } from "./OpencodeV2/Adapter.ts";
import { makeDormantOpencodeV2Provider } from "./OpencodeV2/Provider.ts";
import { makeV2DevelopmentRegistration } from "./OpencodeV2/Development.composition.ts";
import { makeV2ApplicationRegistration } from "./OpencodeV2/Application.composition.ts";
import { ProviderTurnAdmissionsLive } from "../../persistence/Layers/ProviderTurnAdmissions.ts";

/** One aggregate registration service; optional providers cannot replace each other. */
export function appendDormantOpencodeV2(
  registrations: ReadonlyArray<OptionalProviderRegistration>,
  enabled: boolean,
): ReadonlyArray<OptionalProviderRegistration> {
  if (!enabled) return registrations;
  if (registrations.some((registration) => registration.provider === "opencodeV2")) {
    throw new Error("OpenCode v2 is already registered.");
  }
  return [
    ...registrations,
    {
      provider: "opencodeV2",
      providerService: makeDormantOpencodeV2Provider(),
      adapterService: makeDormantOpencodeV2Adapter(),
      capabilities: {
        supportsRemoteProviderRuntime: false,
        supportsLocalRuntimeRemoteWorkspace: false,
        toolInjectionMode: "mcp",
        needsBuiltinsDisabled: true,
        compactionBehavior: "unknown",
        tokenUsageSemantics: "unavailable",
        sessionHistorySemantics: "unknown",
      },
    },
  ];
}

export const composeOptionalProviders = Effect.fn("composeOptionalProviders")(function* (
  registrations: ReadonlyArray<OptionalProviderRegistration>,
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (registrations.some((registration) => registration.provider === "opencodeV2"))
    throw new Error("OpenCode v2 is already registered.");
  return [
    ...registrations,
    yield* environment.BIGBUD_ENABLE_OPENCODE_V2_DEVELOPMENT === "1"
      ? makeV2DevelopmentRegistration(environment)
      : makeV2ApplicationRegistration(),
  ];
});

export const OptionalProviderCompositionLive = Layer.effect(
  OptionalProviderRegistrations,
  Effect.gen(function* () {
    const registrations = yield* OptionalProviderRegistrations;
    return yield* composeOptionalProviders(registrations);
  }),
).pipe(Layer.provide(CliProxyCompositionLive), Layer.provide(ProviderTurnAdmissionsLive));
