import { PROVIDER_KINDS, type ProviderKind } from "@bigbud/contracts";

import { supportsProviderWorkload } from "../provider/providerWorkloadSupport.ts";

export function supportsUsageAccounting(provider: string): provider is ProviderKind {
  return (
    PROVIDER_KINDS.includes(provider as ProviderKind) &&
    supportsProviderWorkload(provider as ProviderKind, "usageAccounting")
  );
}

export function usageProviderCoverage() {
  return PROVIDER_KINDS.map((provider) =>
    supportsProviderWorkload(provider, "usageAccounting")
      ? { provider, status: "available" as const, reason: null }
      : {
          provider,
          status: "unavailable" as const,
          reason: "This provider does not expose reliable token usage data.",
        },
  );
}
