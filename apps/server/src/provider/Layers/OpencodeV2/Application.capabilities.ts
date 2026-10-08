import type { ProviderCapabilities } from "../../ProviderRegistration.ts";

/** Supported routing seams, not model authentication, platform evidence or a release-conformance claim. */
export const V2_APPLICATION_CAPABILITIES = {
  supportsRemoteProviderRuntime: true,
  supportsLocalRuntimeRemoteWorkspace: true,
  toolInjectionMode: "custom-tools",
  needsBuiltinsDisabled: true,
  compactionBehavior: "unknown",
  tokenUsageSemantics: "cumulative-only",
  sessionHistorySemantics: "persistent",
} as const satisfies ProviderCapabilities;
