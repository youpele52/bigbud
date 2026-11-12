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
  opencodeV2: {
    provider: "opencodeV2",
    backend: "agent-runtime",
    supportsLocalRuntimeRemoteWorkspace: true,
    reason:
      "OpenCode v2 routes once-approved bounded remote file tools through the existing agent workspace root; native local filesystem/shell tools remain denied. Raw SSH workspace shell and absent-file CAS are not exposed.",
  },
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
  muse: {
    provider: "muse",
    backend: "unsupported",
    supportsLocalRuntimeRemoteWorkspace: false,
    reason:
      "Muse Code runs only against local workspaces in bigbud's first milestone; remote provider execution and local runtime against a remote workspace are not qualified.",
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

/**
 * Published snapshot capability: whether this provider can run a local runtime against a
 * remote workspace. Health (enabled/installed/probe/status/auth) is deliberately excluded so
 * clients apply the same health rules for local and remote workspaces and can show the real
 * health reason. A provider snapshot may still opt out by declaring `false` explicitly.
 */
export function resolveSnapshotRemoteWorkspaceSupport(
  snapshot: Pick<ServerProvider, "provider" | "supportsLocalRuntimeRemoteWorkspace">,
): boolean {
  return (
    getProviderRemoteWorkspaceConformance(snapshot.provider).supportsLocalRuntimeRemoteWorkspace &&
    snapshot.supportsLocalRuntimeRemoteWorkspace !== false
  );
}
