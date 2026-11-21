import type { ThreadId } from "@bigbud/contracts";
import type { TerminalStateStoreState } from "../../stores/terminal/terminal.store.types";
import { buildTerminalLabelMap } from "./terminalDisplay";

export type TerminalLabelStoreSnapshot = Pick<
  TerminalStateStoreState,
  "terminalStateByThreadId" | "panelTerminalStateByThreadId" | "terminalLabelOverridesByThreadId"
>;

/** The label the terminal's tab shows ("Terminal 2", or the user's rename). */
export function terminalPaneLabel(
  store: TerminalLabelStoreSnapshot,
  threadId: ThreadId,
  terminalId: string,
): string {
  const overrides = store.terminalLabelOverridesByThreadId[threadId] ?? {};
  for (const surface of [store.terminalStateByThreadId, store.panelTerminalStateByThreadId]) {
    const ids = surface[threadId]?.terminalIds ?? [];
    if (ids.includes(terminalId))
      return buildTerminalLabelMap(ids, "Terminal", overrides).get(terminalId) ?? "Terminal";
  }
  return overrides[terminalId]?.trim() || "Terminal";
}
