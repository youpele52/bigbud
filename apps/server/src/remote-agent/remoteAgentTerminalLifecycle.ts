/**
 * Terminal lifecycle for remote-agent terminals (plan §7.2, D2-D8): with the terminal host
 * enabled, remote terminals get the same idle close, memory-pressure close, live limit, screen
 * copies and close-on-quit as local ones, run by the remote host's own Rust code. Each create
 * field is sent only when the agent advertises its protocol 1.9 capability, so older agents keep
 * today's behaviour. Remote creates never ask for `local_launch`: that is the local host's.
 *
 * Opt-in follows the local host flag (`BIGBUD_TERMINAL_HOST`); with it off nothing changes.
 *
 * @module remoteAgentTerminalLifecycle
 */
import { resolveLocalTerminalHostMode } from "../terminal-host/localTerminalHost.paths.ts";
import type { OwnedRemoteAgentPtyOptions } from "./remoteAgentOwnedPty.ts";
import type { RemoteAgentPtyCreateDefaults } from "./remoteAgentPtyClient.lifecycle.ts";

/** Managed (policy applies), with a screen model of the plan's 1,000 scrollback rows (§8.4). */
export const REMOTE_AGENT_TERMINAL_HOST_LIFECYCLE: RemoteAgentPtyCreateDefaults = Object.freeze({
  lifecycleManaged: true,
  screenScrollbackRows: 1_000,
});

export function remoteAgentTerminalLifecycleOptions(
  environment: NodeJS.ProcessEnv = process.env,
): Pick<OwnedRemoteAgentPtyOptions, "hostLifecycle" | "remoteHostControls"> {
  if (resolveLocalTerminalHostMode(environment) !== "enabled") return {};
  return { hostLifecycle: REMOTE_AGENT_TERMINAL_HOST_LIFECYCLE, remoteHostControls: true };
}
