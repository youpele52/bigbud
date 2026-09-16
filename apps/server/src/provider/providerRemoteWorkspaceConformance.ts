import type { ProviderKind } from "@bigbud/contracts/orchestration/orchestration.provider.ts";
import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";

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
    reason:
      "Claude's local MCP bridge dispatches through the configured remote workspace transport.",
  },
  cliProxy: {
    provider: "cliProxy",
    backend: "agent-runtime",
    supportsLocalRuntimeRemoteWorkspace: true,
    reason: "CLIProxyAPI inherits Claude's configured remote workspace transport.",
  },
  codex: {
    provider: "codex",
    backend: "agent-runtime",
    supportsLocalRuntimeRemoteWorkspace: true,
    reason:
      "Codex's local MCP bridge dispatches through the configured remote workspace transport.",
  },
  copilot: {
    provider: "copilot",
    backend: "agent-runtime",
    supportsLocalRuntimeRemoteWorkspace: true,
    reason:
      "Copilot's local session-filesystem bridge dispatches through the configured remote workspace transport.",
  },
  cursor: {
    provider: "cursor",
    backend: "agent-runtime",
    supportsLocalRuntimeRemoteWorkspace: true,
    reason:
      "Cursor ACP filesystem and terminal callbacks dispatch through the configured remote workspace transport.",
  },
  devin: {
    provider: "devin",
    backend: "agent-runtime",
    supportsLocalRuntimeRemoteWorkspace: true,
    reason:
      "Devin ACP filesystem and terminal callbacks dispatch through the configured remote workspace transport.",
  },
  kilocode: {
    provider: "kilocode",
    backend: "agent-runtime",
    supportsLocalRuntimeRemoteWorkspace: true,
    reason:
      "KiloCode's local built-in overrides dispatch through the configured remote workspace transport.",
  },
  opencode: {
    provider: "opencode",
    backend: "agent-runtime",
    supportsLocalRuntimeRemoteWorkspace: true,
    reason:
      "OpenCode's local built-in overrides dispatch through the configured remote workspace transport.",
  },
  pi: {
    provider: "pi",
    backend: "agent-runtime",
    supportsLocalRuntimeRemoteWorkspace: true,
    reason:
      "Pi's local extension bridge dispatches through the configured remote workspace transport.",
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

export function providerAdvertisesRemoteWorkspaceSupport(
  snapshot: Pick<
    ServerProvider,
    "auth" | "enabled" | "initialProbeComplete" | "installed" | "provider" | "status"
  >,
): boolean {
  return (
    getProviderRemoteWorkspaceConformance(snapshot.provider).supportsLocalRuntimeRemoteWorkspace &&
    snapshot.enabled &&
    snapshot.installed &&
    snapshot.initialProbeComplete === true &&
    snapshot.status === "ready" &&
    snapshot.auth.status === "authenticated"
  );
}
