import { PROVIDER_KINDS, type ProviderKind } from "@bigbud/contracts";

const PROVIDER_USAGE_ACCOUNTING_SUPPORT = {
  codex: true,
  claudeAgent: true,
  cliProxy: false,
  copilot: true,
  kilocode: true,
  opencode: true,
  pi: true,
  cursor: false,
  devin: false,
} as const satisfies Record<ProviderKind, boolean>;

export function supportsUsageAccounting(provider: string): provider is ProviderKind {
  return (
    PROVIDER_KINDS.includes(provider as ProviderKind) &&
    PROVIDER_USAGE_ACCOUNTING_SUPPORT[provider as ProviderKind]
  );
}

export function usageProviderCoverage() {
  return PROVIDER_KINDS.map((provider) =>
    PROVIDER_USAGE_ACCOUNTING_SUPPORT[provider]
      ? { provider, status: "available" as const, reason: null }
      : {
          provider,
          status: "unavailable" as const,
          reason: "This provider does not expose reliable token usage data.",
        },
  );
}
