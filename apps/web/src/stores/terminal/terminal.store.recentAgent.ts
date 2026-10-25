import type { ProviderKind } from "@bigbud/contracts/orchestration/orchestration.provider.ts";

import type { TerminalAgentIdentityState } from "./terminal.store.identity";

interface RecentTerminalAgent {
  readonly key: string;
  readonly provider: ProviderKind;
  readonly lastActiveAt: string;
}

let cachedProviders: TerminalAgentIdentityState["terminalAgentProviderByKey"] | undefined;
let cachedVersions: TerminalAgentIdentityState["terminalAgentVersionByKey"] | undefined;
let cachedAgents = new Map<string, RecentTerminalAgent>();

/** Index identities once per identity change, not once per sidebar row or output batch. */
function recentTerminalAgents(state: TerminalAgentIdentityState) {
  if (
    cachedProviders === state.terminalAgentProviderByKey &&
    cachedVersions === state.terminalAgentVersionByKey
  )
    return cachedAgents;

  const agents = new Map<string, RecentTerminalAgent>();
  for (const [key, version] of Object.entries(state.terminalAgentVersionByKey)) {
    const provider = state.terminalAgentProviderByKey[key];
    if (!provider || version.status !== "running") continue;
    const threadId = key.slice(0, key.indexOf("\u0000"));
    const lastActiveAt = version.lastActiveAt ?? version.updatedAt;
    const current = agents.get(threadId);
    if (!current || lastActiveAt > current.lastActiveAt)
      agents.set(threadId, { key, provider, lastActiveAt });
  }
  cachedProviders = state.terminalAgentProviderByKey;
  cachedVersions = state.terminalAgentVersionByKey;
  cachedAgents = agents;
  return agents;
}

/** Return only a provider so unrelated terminal output cannot rerender thread icons. */
export function selectThreadTerminalProvider(
  state: TerminalAgentIdentityState,
  threadId: string,
): ProviderKind | null {
  return recentTerminalAgents(state).get(threadId)?.provider ?? null;
}

/** Input can promote an older pane, without modifying lifecycle ordering or writing per keypress. */
export function markTerminalAgentActive(
  state: TerminalAgentIdentityState,
  threadId: string,
  terminalId: string,
): Pick<TerminalAgentIdentityState, "terminalAgentVersionByKey"> | null {
  const key = `${threadId}\u0000${terminalId}`;
  const version = state.terminalAgentVersionByKey[key];
  if (!state.terminalAgentProviderByKey[key] || version?.status !== "running") return null;
  const recent = recentTerminalAgents(state).get(threadId);
  if (recent?.key === key) return null;
  // Stay in the server's clock domain: a fast client clock must not mask later provider switches.
  const lastActiveAt = new Date(
    Date.parse(recent?.lastActiveAt ?? version.updatedAt) + 1,
  ).toISOString();
  return {
    terminalAgentVersionByKey: {
      ...state.terminalAgentVersionByKey,
      [key]: { ...version, lastActiveAt },
    },
  };
}
