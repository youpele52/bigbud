import type { ProviderKind } from "@bigbud/contracts/orchestration/orchestration.provider.ts";

export type ProviderRemoteWorkspaceBackend = "agent-runtime" | "unsupported";

export interface ProviderRemoteWorkspaceConformance {
  readonly provider: ProviderKind;
  readonly backend: ProviderRemoteWorkspaceBackend;
  readonly supportsLocalRuntimeRemoteWorkspace: boolean;
  readonly reason: string;
}

const CONFORMANCE: Record<ProviderKind, ProviderRemoteWorkspaceConformance> = {
  claudeAgent: {
    provider: "claudeAgent",
    backend: "agent-runtime",
    supportsLocalRuntimeRemoteWorkspace: true,
    reason: "Claude's local MCP bridge dispatches through the shared remote-agent runtime.",
  },
  cliProxy: {
    provider: "cliProxy",
    backend: "agent-runtime",
    supportsLocalRuntimeRemoteWorkspace: true,
    reason: "CLIProxyAPI inherits Claude's shared remote-agent bridge path.",
  },
  codex: {
    provider: "codex",
    backend: "agent-runtime",
    supportsLocalRuntimeRemoteWorkspace: true,
    reason: "Codex's local MCP bridge dispatches through the shared remote-agent runtime.",
  },
  copilot: {
    provider: "copilot",
    backend: "agent-runtime",
    supportsLocalRuntimeRemoteWorkspace: true,
    reason: "Copilot's local session-filesystem bridge dispatches through the remote agent.",
  },
  cursor: {
    provider: "cursor",
    backend: "unsupported",
    supportsLocalRuntimeRemoteWorkspace: false,
    reason: "Cursor custom tools are not yet backed by the provider-neutral runtime.",
  },
  devin: {
    provider: "devin",
    backend: "unsupported",
    supportsLocalRuntimeRemoteWorkspace: false,
    reason: "Devin ACP still starts from a local cwd and has no remote workspace bridge.",
  },
  kilocode: {
    provider: "kilocode",
    backend: "agent-runtime",
    supportsLocalRuntimeRemoteWorkspace: true,
    reason: "KiloCode's local built-in overrides dispatch through the remote agent.",
  },
  opencode: {
    provider: "opencode",
    backend: "agent-runtime",
    supportsLocalRuntimeRemoteWorkspace: true,
    reason: "OpenCode's local built-in overrides dispatch through the remote agent.",
  },
  pi: {
    provider: "pi",
    backend: "agent-runtime",
    supportsLocalRuntimeRemoteWorkspace: true,
    reason: "Pi's local extension bridge dispatches through the remote agent.",
  },
};

export function getProviderRemoteWorkspaceConformance(
  provider: ProviderKind,
): ProviderRemoteWorkspaceConformance {
  const conformance = CONFORMANCE[provider];
  if (!conformance) {
    throw new Error(`Provider remote workspace conformance is not registered for '${provider}'.`);
  }
  return conformance;
}
