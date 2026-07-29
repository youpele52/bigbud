import type { ProviderKind } from "@bigbud/contracts";

import type {
  OptionalProviderRegistration,
  ProviderCapabilities,
  ProviderToolInjectionMode,
} from "./ProviderRegistration.ts";

export type { ProviderCapabilities, ProviderToolInjectionMode };
export type ProviderCapabilitiesResolver = (provider: ProviderKind) => ProviderCapabilities;

const CORE_PROVIDER_CAPABILITIES: Partial<Record<ProviderKind, ProviderCapabilities>> = {
  claudeAgent: {
    supportsRemoteProviderRuntime: false,
    supportsLocalRuntimeRemoteWorkspace: true,
    toolInjectionMode: "mcp",
    needsBuiltinsDisabled: true,
  },
  codex: {
    supportsRemoteProviderRuntime: true,
    supportsLocalRuntimeRemoteWorkspace: true,
    toolInjectionMode: "mcp",
    needsBuiltinsDisabled: false,
  },
  copilot: {
    supportsRemoteProviderRuntime: false,
    supportsLocalRuntimeRemoteWorkspace: true,
    toolInjectionMode: "mcp",
    needsBuiltinsDisabled: true,
  },
  cursor: {
    supportsRemoteProviderRuntime: false,
    supportsLocalRuntimeRemoteWorkspace: false,
    toolInjectionMode: "custom-tools",
    needsBuiltinsDisabled: false,
  },
  opencode: {
    supportsRemoteProviderRuntime: true,
    supportsLocalRuntimeRemoteWorkspace: true,
    toolInjectionMode: "builtin-override",
    needsBuiltinsDisabled: false,
  },
  kilocode: {
    supportsRemoteProviderRuntime: true,
    supportsLocalRuntimeRemoteWorkspace: true,
    toolInjectionMode: "builtin-override",
    needsBuiltinsDisabled: false,
  },
  pi: {
    supportsRemoteProviderRuntime: true,
    supportsLocalRuntimeRemoteWorkspace: true,
    toolInjectionMode: "custom-tools",
    needsBuiltinsDisabled: true,
  },
  devin: {
    supportsRemoteProviderRuntime: false,
    supportsLocalRuntimeRemoteWorkspace: true,
    toolInjectionMode: "custom-tools",
    needsBuiltinsDisabled: false,
  },
};

function missingCapabilities(provider: ProviderKind): never {
  throw new Error(`Provider capabilities are not registered for '${provider}'.`);
}

export function getProviderCapabilities(provider: ProviderKind): ProviderCapabilities {
  return CORE_PROVIDER_CAPABILITIES[provider] ?? missingCapabilities(provider);
}

export function makeProviderCapabilitiesResolver(
  registrations: ReadonlyArray<Pick<OptionalProviderRegistration, "provider" | "capabilities">>,
): ProviderCapabilitiesResolver {
  const optionalCapabilities = new Map(
    registrations.map((registration) => [registration.provider, registration.capabilities]),
  );
  return (provider) =>
    CORE_PROVIDER_CAPABILITIES[provider] ??
    optionalCapabilities.get(provider) ??
    missingCapabilities(provider);
}

export function isProviderRegistered(
  provider: ProviderKind,
  registrations: ReadonlyArray<Pick<OptionalProviderRegistration, "provider">>,
): boolean {
  return (
    CORE_PROVIDER_CAPABILITIES[provider] !== undefined ||
    registrations.some((registration) => registration.provider === provider)
  );
}
