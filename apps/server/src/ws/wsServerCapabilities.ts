/**
 * The `workspaceCapabilities` the server config reports to clients: remote-agent support and
 * whether new local terminals run in the background terminal host (the same selection
 * `server.pty.ts` makes, so Windows and an opt-out always report it off).
 *
 * @module wsServerCapabilities
 */
import type { ServerWorkspaceCapabilities } from "@bigbud/contracts/server/server";

import { localTerminalHostSelection } from "../terminal-host/localTerminalHost.layer.ts";

export function serverWorkspaceCapabilities(input: {
  readonly remoteAgentEnabled: boolean;
  readonly stateDir: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}): ServerWorkspaceCapabilities {
  const hostMode = localTerminalHostSelection({
    stateDir: input.stateDir,
    ...(input.environment ? { environment: input.environment } : {}),
    ...(input.platform ? { platform: input.platform } : {}),
  });
  return {
    remoteAgent: {
      enabled: input.remoteAgentEnabled,
      supportsDirectoryWatch: true,
      supportsPtyReattach: input.remoteAgentEnabled,
    },
    terminalHost: { enabled: hostMode === "enabled" },
  };
}
