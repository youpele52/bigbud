import type { ThreadId } from "@bigbud/contracts";

import { selectTerminalEventEntries, terminalEventBufferKey } from "../../stores/terminal";
import type { TerminalAgentKind } from "../../stores/terminal/terminal.store.agentKind";
import type { TerminalStateStoreState } from "../../stores/terminal/terminal.store.types";
import { resolveTerminalProviderFromEvents } from "./terminalDisplay";

export type TerminalAgentSource = Pick<
  TerminalStateStoreState,
  "terminalAgentProviderByKey" | "terminalEventEntriesByKey"
>;

/**
 * The coding agent running in a terminal: the live detection when the store has one (including an
 * explicit "none"), otherwise the agent recorded in the terminal's buffered events.
 */
export function resolveTerminalAgentKind(
  source: TerminalAgentSource,
  threadId: ThreadId,
  terminalId: string,
): TerminalAgentKind | null {
  const key = terminalEventBufferKey(threadId, terminalId);
  if (Object.hasOwn(source.terminalAgentProviderByKey, key))
    return source.terminalAgentProviderByKey[key] ?? null;
  return resolveTerminalProviderFromEvents(
    selectTerminalEventEntries(source.terminalEventEntriesByKey, threadId, terminalId),
  );
}
