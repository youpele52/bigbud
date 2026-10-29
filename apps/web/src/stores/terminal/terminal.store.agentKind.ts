import {
  TERMINAL_ONLY_AGENT_KINDS,
  type TerminalOnlyAgentKind,
} from "@bigbud/contracts/constants/terminal.constant.ts";
import type { ProviderKind } from "@bigbud/contracts/orchestration/orchestration.provider.ts";
import type { TerminalAgentIdentity } from "@bigbud/contracts/workspace/terminal.agentIdentity.ts";

/** A terminal pane's logo identity: a native provider, or a terminal-only exception such as herdr. */
export type TerminalAgentKind = ProviderKind | TerminalOnlyAgentKind;

function isTerminalOnlyAgentKind(id: string): id is TerminalOnlyAgentKind {
  return (TERMINAL_ONLY_AGENT_KINDS as ReadonlyArray<string>).includes(id);
}

/**
 * Native providers win; a terminal-only identity fills in only when no provider was detected.
 * `undefined` (a legacy server that never reported) is preserved so callers can keep it unknown.
 */
export function resolveTerminalAgentKind(
  provider: ProviderKind | null | undefined,
  agent: TerminalAgentIdentity | null | undefined,
): TerminalAgentKind | null | undefined {
  if (provider) return provider;
  if (agent && isTerminalOnlyAgentKind(agent.id)) return agent.id;
  return provider;
}
