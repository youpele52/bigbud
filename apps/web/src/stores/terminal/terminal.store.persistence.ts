import {
  excludeDismissedPanes,
  dismissedPaneKey,
  type DismissedTerminalPanes,
} from "./terminal.store.dismiss";
import { ThreadId } from "@bigbud/contracts";
import {
  createDefaultThreadTerminalState,
  isDefaultThreadTerminalState,
  normalizeThreadTerminalState,
  type ThreadTerminalState,
} from "./helpers.store";
import {
  pruneRestoredPanesForInventory,
  readLatestTerminalInventory,
} from "./terminal.store.inventory";
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
import { createBackendScopedStorage } from "../../lib/backendScopedStorage";
import { skipUnchangedPersistWrites } from "../../lib/storage.persistGate";
import type { TerminalLayoutMode } from "./terminal.store.layout";
import type { TerminalStateStoreState } from "./terminal.store.types";

const STORAGE_KEY = "bigbud:terminal-state:v1";

/** Terminal state is per backend thread. In a bound window the legacy aliases resolve inside
 * the backend namespace too, so the local window's keys are never read or migrated. */
function createTerminalStateStorage() {
  const base = typeof window !== "undefined" ? window.localStorage : undefined;
  return resolveStorage(base ? createBackendScopedStorage(base) : undefined, {
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

/** One surface's saved panes, every one `restored`; unusable entries are dropped. */
function restoredSurfaces(saved: unknown): Record<string, ThreadTerminalState> {
  const surfaces: Record<string, ThreadTerminalState> = {};
  if (!saved || typeof saved !== "object") return surfaces;
  for (const [id, value] of Object.entries(saved)) {
    if (!value || typeof value !== "object") continue;
    const pane = value as Partial<ThreadTerminalState>;
    if (!Array.isArray(pane.terminalIds)) continue;
    const defaults = createDefaultThreadTerminalState();
    const normalized = normalizeThreadTerminalState({
      ...defaults,
      ...pane,
      runningTerminalIds: Array.isArray(pane.runningTerminalIds) ? pane.runningTerminalIds : [],
      terminalGroups: Array.isArray(pane.terminalGroups) ? pane.terminalGroups : [],
      restoredTerminalIds: [...pane.terminalIds],
    });
    if (isDefaultThreadTerminalState(normalized)) continue;
    surfaces[id] = normalized;
  }
  return surfaces;
}

/**
 * Every pane loaded from storage, drawer and right panel alike, is `restored`: it may reattach
 * but is never respawned. The first authoritative inventory (or one already received) drops
 * restored panes the host lacks.
 */
function markHydratedPanesRestored(
  state: TerminalStateStoreState,
  hydrated: { readonly drawer: boolean; readonly panel: boolean },
): TerminalStateStoreState {
  if (!hydrated.drawer && !hydrated.panel) return state;
  const terminalStateByThreadId = hydrated.drawer
    ? restoredSurfaces(state.terminalStateByThreadId)
    : state.terminalStateByThreadId;
  const panelTerminalStateByThreadId = hydrated.panel
    ? restoredSurfaces(state.panelTerminalStateByThreadId)
    : state.panelTerminalStateByThreadId;
  const restored = [terminalStateByThreadId, panelTerminalStateByThreadId].some((surfaces) =>
    Object.values(surfaces).some((surface) => (surface.restoredTerminalIds?.length ?? 0) > 0),
  );
  const next: TerminalStateStoreState = {
    ...state,
    terminalStateByThreadId:
      terminalStateByThreadId as TerminalStateStoreState["terminalStateByThreadId"],
    panelTerminalStateByThreadId:
      panelTerminalStateByThreadId as TerminalStateStoreState["panelTerminalStateByThreadId"],
    restoredPanesAwaitingInventory: restored,
  };
  const inventory = readLatestTerminalInventory();
  return restored && inventory
    ? { ...next, ...pruneRestoredPanesForInventory(next, inventory) }
    : next;
}

type PersistedTerminalState = Pick<
  TerminalStateStoreState,
  | "dismissedTerminalPanes"
  | "terminalProfileLaunches"
  | "terminalLayoutByThreadId"
  | "terminalWslDistributionByThreadId"
  | "terminalStateByThreadId"
  | "panelTerminalStateByThreadId"
  | "terminalLabelOverridesByThreadId"
>;

export const terminalPersistenceOptions = {
  name: STORAGE_KEY,
  // v2 (plan W1): no implicit "default" pane; hydrated panes are restored, never respawned.
  version: 2,
  // Shapes are unchanged; `merge` marks every hydrated pane restored, so v1 data is kept.
  migrate: (persisted: unknown) => persisted as PersistedTerminalState,
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
    // Right-panel panes survive a reload too (restored, like the drawer's).
    panelTerminalStateByThreadId: state.panelTerminalStateByThreadId,
    terminalLabelOverridesByThreadId: state.terminalLabelOverridesByThreadId,
  }),
  merge: (persisted: unknown, current: TerminalStateStoreState): TerminalStateStoreState => {
    const saved = persisted && typeof persisted === "object" ? persisted : {};
    const hydratedPanes = {
      drawer: "terminalStateByThreadId" in saved,
      panel: "panelTerminalStateByThreadId" in saved,
    };
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
          key === dismissedPaneKey(entry.threadId, entry.terminalId),
      ),
    );
    if (Object.keys(dismissedTerminalPanes).length === 0)
      return markHydratedPanesRestored({ ...merged, dismissedTerminalPanes }, hydratedPanes);
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
    return markHydratedPanesRestored(next, hydratedPanes);
  },
};
