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
    compactionBehavior: "signaled",
    tokenUsageSemantics: "current-context",
    sessionHistorySemantics: "bounded",
  },
  codex: {
    supportsRemoteProviderRuntime: true,
    supportsLocalRuntimeRemoteWorkspace: true,
    toolInjectionMode: "mcp",
    needsBuiltinsDisabled: false,
    compactionBehavior: "signaled",
    tokenUsageSemantics: "current-context",
    sessionHistorySemantics: "bounded",
  },
  copilot: {
    supportsRemoteProviderRuntime: false,
    supportsLocalRuntimeRemoteWorkspace: true,
    toolInjectionMode: "mcp",
    needsBuiltinsDisabled: true,
    compactionBehavior: "unknown",
    tokenUsageSemantics: "unavailable",
    sessionHistorySemantics: "unknown",
  },
  cursor: {
    supportsRemoteProviderRuntime: false,
    supportsLocalRuntimeRemoteWorkspace: false,
    toolInjectionMode: "custom-tools",
    needsBuiltinsDisabled: false,
    compactionBehavior: "unknown",
    tokenUsageSemantics: "unavailable",
    sessionHistorySemantics: "unknown",
  },
  opencode: {
    supportsRemoteProviderRuntime: true,
    supportsLocalRuntimeRemoteWorkspace: true,
    toolInjectionMode: "builtin-override",
    needsBuiltinsDisabled: false,
    compactionBehavior: "unknown",
    tokenUsageSemantics: "unavailable",
    sessionHistorySemantics: "unknown",
  },
  kilocode: {
    supportsRemoteProviderRuntime: true,
    supportsLocalRuntimeRemoteWorkspace: true,
    toolInjectionMode: "builtin-override",
    needsBuiltinsDisabled: false,
    compactionBehavior: "signaled",
    tokenUsageSemantics: "current-context",
    sessionHistorySemantics: "bounded",
  },
  pi: {
    supportsRemoteProviderRuntime: true,
    supportsLocalRuntimeRemoteWorkspace: true,
    toolInjectionMode: "custom-tools",
    needsBuiltinsDisabled: true,
    compactionBehavior: "signaled",
    tokenUsageSemantics: "current-context",
    sessionHistorySemantics: "bounded",
  },
  devin: {
    supportsRemoteProviderRuntime: false,
    supportsLocalRuntimeRemoteWorkspace: true,
    toolInjectionMode: "custom-tools",
    needsBuiltinsDisabled: false,
    compactionBehavior: "unknown",
    tokenUsageSemantics: "unavailable",
    sessionHistorySemantics: "unknown",
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
