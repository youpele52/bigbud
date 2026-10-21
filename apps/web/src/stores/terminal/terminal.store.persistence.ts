import { createJSONStorage } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";
import { skipUnchangedPersistWrites } from "../../lib/storage.persistGate";
import type { TerminalLayoutMode } from "./terminal.store.layout";
import type { TerminalStateStoreState } from "./terminal.store.types";

const STORAGE_KEY = "bigbud:terminal-state:v1";

function createTerminalStateStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined, {
    legacyKeysByName: { [STORAGE_KEY]: ["t3code:terminal-state:v1"] },
  });
}

/** Ignore corrupt or future presentation values without discarding saved terminal settings. */
function hydrateTerminalLayouts(value: unknown): Record<string, TerminalLayoutMode> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, TerminalLayoutMode] =>
        entry[0].length > 0 &&
        (entry[1] === "split" || entry[1] === "terminal-only" || entry[1] === "chat-only"),
    ),
  );
}

type PersistedTerminalState = Pick<
  TerminalStateStoreState,
  | "terminalLayoutByThreadId"
  | "terminalWslDistributionByThreadId"
  | "terminalStateByThreadId"
  | "terminalLabelOverridesByThreadId"
>;

export const terminalPersistenceOptions = {
  name: STORAGE_KEY,
  // Additive optional field: retain v1 data, including legacy-key migration.
  version: 1,
  // Output events update only non-persisted slices; do not re-serialize per terminal batch.
  storage: skipUnchangedPersistWrites(
    createJSONStorage<PersistedTerminalState>(createTerminalStateStorage),
  ),
  partialize: (state: TerminalStateStoreState) => ({
    terminalLayoutByThreadId: state.terminalLayoutByThreadId,
    terminalWslDistributionByThreadId: state.terminalWslDistributionByThreadId,
    terminalStateByThreadId: state.terminalStateByThreadId,
    terminalLabelOverridesByThreadId: state.terminalLabelOverridesByThreadId,
  }),
  merge: (persisted: unknown, current: TerminalStateStoreState): TerminalStateStoreState => {
    const saved = persisted && typeof persisted === "object" ? persisted : {};
    return {
      ...current,
      ...saved,
      terminalLayoutByThreadId: hydrateTerminalLayouts(
        "terminalLayoutByThreadId" in saved ? saved.terminalLayoutByThreadId : undefined,
      ),
    };
  },
};
