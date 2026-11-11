import { createJSONStorage } from "zustand/middleware";
import * as Schema from "effect/Schema";
import { ShellHostScope, ShellSelection } from "@bigbud/contracts/workspace/terminalShell.ts";

const ProfileLaunches = Schema.Record(
  Schema.String,
  Schema.Struct({
    shellSelection: Schema.optional(ShellSelection),
    host: Schema.optional(ShellHostScope),
    requiresChoice: Schema.optional(Schema.Boolean),
    context: Schema.optional(
      Schema.Struct({
        cwd: Schema.String,
        worktreePath: Schema.optional(Schema.NullOr(Schema.String)),
        executionTargetId: Schema.optional(Schema.String),
        runtimeEnv: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      }),
    ),
  }),
);
function hydrateProfileLaunches(value: unknown) {
  try {
    return Schema.decodeUnknownSync(ProfileLaunches)(value);
  } catch {
    return {};
  }
}

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
  | "terminalProfileLaunches"
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
    terminalProfileLaunches: state.terminalProfileLaunches,
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
      terminalProfileLaunches: hydrateProfileLaunches(
        "terminalProfileLaunches" in saved ? saved.terminalProfileLaunches : undefined,
      ),
      terminalLayoutByThreadId: hydrateTerminalLayouts(
        "terminalLayoutByThreadId" in saved ? saved.terminalLayoutByThreadId : undefined,
      ),
    };
  },
};
