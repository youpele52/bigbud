import type { ProviderKind } from "@bigbud/contracts";

import type { TerminalEventEntry } from "./helpers.store";
import type { TerminalAgentVersion } from "./terminal.store.identity";

interface TerminalTransientState {
  terminalEventEntriesByKey: Record<string, ReadonlyArray<TerminalEventEntry>>;
  terminalEventLastIdsByKey: Record<string, number>;
  terminalAgentProviderByKey: Record<string, ProviderKind | null>;
  terminalAgentVersionByKey: Record<string, TerminalAgentVersion>;
}

export function removeTerminalTransientState(
  state: TerminalTransientState,
  shouldRemove: (key: string) => boolean,
): { state: TerminalTransientState; removed: boolean } {
  const terminalEventEntriesByKey = { ...state.terminalEventEntriesByKey };
  const terminalEventLastIdsByKey = { ...state.terminalEventLastIdsByKey };
  const terminalAgentProviderByKey = { ...state.terminalAgentProviderByKey };
  const terminalAgentVersionByKey = { ...state.terminalAgentVersionByKey };
  let removed = false;

  for (const key of new Set([
    ...Object.keys(terminalEventEntriesByKey),
    ...Object.keys(terminalEventLastIdsByKey),
    ...Object.keys(terminalAgentProviderByKey),
    ...Object.keys(terminalAgentVersionByKey),
  ])) {
    if (!shouldRemove(key)) continue;
    delete terminalEventEntriesByKey[key];
    delete terminalEventLastIdsByKey[key];
    delete terminalAgentProviderByKey[key];
    delete terminalAgentVersionByKey[key];
    removed = true;
  }

  return {
    state: {
      terminalEventEntriesByKey,
      terminalEventLastIdsByKey,
      terminalAgentProviderByKey,
      terminalAgentVersionByKey,
    },
    removed,
  };
}
