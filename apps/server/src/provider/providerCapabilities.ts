import type { ProviderKind } from "@bigbud/contracts";

export type ProviderToolInjectionMode = "builtin-override" | "mcp" | "custom-tools";

export interface ProviderCapabilities {
  readonly supportsRemoteProviderRuntime: boolean;
  readonly supportsLocalRuntimeRemoteWorkspace: boolean;
  readonly toolInjectionMode: ProviderToolInjectionMode;
  readonly needsBuiltinsDisabled: boolean;
}

const PROVIDER_CAPABILITIES: Record<ProviderKind, ProviderCapabilities> = {
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
  pi: {
    supportsRemoteProviderRuntime: true,
    supportsLocalRuntimeRemoteWorkspace: true,
    toolInjectionMode: "custom-tools",
    needsBuiltinsDisabled: true,
  },
};

export function getProviderCapabilities(provider: ProviderKind): ProviderCapabilities {
  return PROVIDER_CAPABILITIES[provider];
}
