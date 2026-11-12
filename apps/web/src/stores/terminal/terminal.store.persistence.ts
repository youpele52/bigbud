import {
  excludeDismissedPanes,
  dismissedPaneKey,
  type DismissedTerminalPanes,
} from "./terminal.store.dismiss";
import { ThreadId } from "@bigbud/contracts";
import { createDefaultThreadTerminalState } from "./helpers.store";
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
  | "dismissedTerminalPanes"
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
    dismissedTerminalPanes: state.dismissedTerminalPanes,
    terminalProfileLaunches: state.terminalProfileLaunches,
    terminalLayoutByThreadId: state.terminalLayoutByThreadId,
    terminalWslDistributionByThreadId: state.terminalWslDistributionByThreadId,
    terminalStateByThreadId: state.terminalStateByThreadId,
    terminalLabelOverridesByThreadId: state.terminalLabelOverridesByThreadId,
  }),
  merge: (persisted: unknown, current: TerminalStateStoreState): TerminalStateStoreState => {
    const saved = persisted && typeof persisted === "object" ? persisted : {};
    const merged = {
      ...current,
      ...saved,
      terminalProfileLaunches: hydrateProfileLaunches(
        "terminalProfileLaunches" in saved ? saved.terminalProfileLaunches : undefined,
      ),
      terminalLayoutByThreadId: hydrateTerminalLayouts(
        "terminalLayoutByThreadId" in saved ? saved.terminalLayoutByThreadId : undefined,
      ),
    };
    const dismissed = Schema.Record(
      Schema.String,
      Schema.Struct({
        threadId: Schema.String,
        terminalId: Schema.String,
        replacementId: Schema.String,
      }),
    );
    let dismissedTerminalPanes: DismissedTerminalPanes = {};
    try {
      dismissedTerminalPanes = Schema.decodeUnknownSync(dismissed)(
        merged.dismissedTerminalPanes ?? {},
      );
    } catch {
      /* Ignore malformed presentation state. */
    }
    dismissedTerminalPanes = Object.fromEntries(
      Object.entries(dismissedTerminalPanes).filter(
        ([key, entry]) =>
          entry.threadId.length > 0 &&
          entry.terminalId.length > 0 &&
          entry.replacementId.length > 0 &&
          entry.replacementId !== entry.terminalId &&
          key === dismissedPaneKey(entry.threadId, entry.terminalId),
      ),
    );
    if (Object.keys(dismissedTerminalPanes).length === 0)
      return { ...merged, dismissedTerminalPanes };
    const next = {
      ...merged,
      dismissedTerminalPanes,
      terminalStateByThreadId: { ...merged.terminalStateByThreadId },
      panelTerminalStateByThreadId: { ...merged.panelTerminalStateByThreadId },
    };
    for (const entry of Object.values(dismissedTerminalPanes)) {
      const id = ThreadId.makeUnsafe(entry.threadId);
      for (const field of ["terminalStateByThreadId", "panelTerminalStateByThreadId"] as const) {
        next[field][id] = excludeDismissedPanes(
          next,
          id,
          next[field][id] ?? createDefaultThreadTerminalState(),
        );
      }
    }
    return next;
  },
};
