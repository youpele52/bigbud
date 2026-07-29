import { Effect, Layer } from "effect";

import {
  OptionalProviderRegistrations,
  type ProviderCapabilities,
} from "../../ProviderRegistration.ts";
import { CliProxyAdapter } from "../../Services/CliProxy/Adapter.ts";
import { CliProxyProvider } from "../../Services/CliProxy/Provider.ts";
import { CliProxyAdapterLive } from "./Adapter.ts";
import { CliProxyLifecycleLive } from "./Lifecycle.ts";
import { CliProxyProviderLive } from "./Provider.ts";

export function isCliProxyCompositionEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment.BIGBUD_DISABLE_CLIPROXY !== "1";
}

export const CLIPROXY_PROVIDER_CAPABILITIES: ProviderCapabilities = {
  supportsRemoteProviderRuntime: false,
  supportsLocalRuntimeRemoteWorkspace: true,
  toolInjectionMode: "mcp",
  needsBuiltinsDisabled: true,
};

const implementationLayer = Layer.mergeAll(
  CliProxyAdapterLive.pipe(Layer.provide(CliProxyLifecycleLive)),
  CliProxyProviderLive.pipe(Layer.provide(CliProxyLifecycleLive)),
  CliProxyLifecycleLive,
);

const enabledCompositionLayer = Layer.effect(
  OptionalProviderRegistrations,
  Effect.gen(function* () {
    const providerService = yield* CliProxyProvider;
    const adapterService = yield* CliProxyAdapter;
    return [
      {
        provider: "cliProxy",
        providerService,
        adapterService,
        capabilities: CLIPROXY_PROVIDER_CAPABILITIES,
      },
    ] as const;
  }),
).pipe(Layer.provide(implementationLayer));

const disabledCompositionLayer = Layer.succeed(OptionalProviderRegistrations, []);

export function makeCliProxyCompositionLive(options: {
  readonly enabled: false;
}): typeof disabledCompositionLayer;
export function makeCliProxyCompositionLive(options?: {
  readonly enabled?: boolean;
}): typeof enabledCompositionLayer | typeof disabledCompositionLayer;
export function makeCliProxyCompositionLive(options?: { readonly enabled?: boolean }) {
  return (options?.enabled ?? isCliProxyCompositionEnabled())
    ? enabledCompositionLayer
    : disabledCompositionLayer;
}

export const CliProxyCompositionLive = makeCliProxyCompositionLive();
