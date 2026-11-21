import { ThreadId } from "@bigbud/contracts";
import type { TerminalSessionInventory } from "@bigbud/contracts/workspace/terminal.stream.ts";
import { beforeEach, describe, expect, it } from "vitest";

import { selectThreadSurfacePanes, selectThreadTerminalState } from "./helpers.store";
import { useTerminalStateStore } from "./terminal.store";
import { terminalPaneOpenOptions } from "./terminal.store.paneOrigin";
import { terminalPersistenceOptions } from "./terminal.store.persistence";
import { resetTerminalStore, THREAD_ID } from "./terminal.store.test.helpers";

const OTHER_THREAD = ThreadId.makeUnsafe("thread-2");
const drawer = (threadId = THREAD_ID) =>
  selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, threadId);
const inventory = (
  sessions: Array<[string, string]>,
  createdAt = "2026-11-21T00:00:00.000Z",
): TerminalSessionInventory => ({
  type: "inventory",
  createdAt,
  sessions: sessions.map(([threadId, terminalId]) => ({ threadId, terminalId })),
});

/** Rehydrates `panes` from storage, as a reload or backend-storage switch does. */
function hydrate(panes: Record<string, string[]>) {
  const saved = {
    terminalStateByThreadId: Object.fromEntries(
      Object.entries(panes).map(([threadId, terminalIds]) => [
        threadId,
        {
          terminalOpen: true,
          terminalHeight: 280,
          terminalIds,
          runningTerminalIds: [],
          activeTerminalId: terminalIds[0] ?? "",
          terminalGroups: [],
          activeTerminalGroupId: "",
        },
      ]),
    ),
  };
  useTerminalStateStore.setState(
    terminalPersistenceOptions.merge(saved, useTerminalStateStore.getState()),
  );
}

describe("terminal lifecycle (plan D1)", () => {
  beforeEach(resetTerminalStore);

  it("gives a thread no terminal until the user opens one", () => {
    expect(drawer()).toMatchObject({ terminalIds: [], terminalOpen: false });
    expect(selectThreadSurfacePanes(useTerminalStateStore.getState(), THREAD_ID)).toEqual([]);
  });

  it("opening an empty drawer creates exactly one user-created pane", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalOpen(THREAD_ID, true);
    store.setTerminalOpen(THREAD_ID, true);
    const [pane, ...rest] = drawer().terminalIds;
    expect(rest).toEqual([]);
    expect(pane).toMatch(/^terminal-/);
    expect(drawer().terminalOpen).toBe(true);
    expect(terminalPaneOpenOptions(THREAD_ID, pane!)).toEqual({});
    // The first pane inherits nothing, so it never demands a shell-profile choice.
    expect(useTerminalStateStore.getState().terminalProfileLaunches).toEqual({});
  });

  it("minimizing keeps panes; closing the last pane empties and closes the surface", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(THREAD_ID, "a");
    store.setTerminalOpen(THREAD_ID, false);
    expect(drawer()).toMatchObject({ terminalIds: ["a"], terminalOpen: false });
    store.setTerminalOpen(THREAD_ID, true);
    store.closeTerminal(THREAD_ID, "a");
    expect(drawer()).toMatchObject({ terminalIds: [], terminalOpen: false, activeTerminalId: "" });
    expect(useTerminalStateStore.getState().terminalStateByThreadId[THREAD_ID]).toBeUndefined();
  });

  it("never creates a right-panel pane implicitly", () => {
    const store = useTerminalStateStore.getState();
    store.setPanelTerminalOpen(THREAD_ID, true);
    store.setPanelTerminalOpen(OTHER_THREAD, true);
    expect(useTerminalStateStore.getState().panelTerminalStateByThreadId).toEqual({});
    store.newPanelTerminal(THREAD_ID, "panel-a");
    store.closePanelTerminal(THREAD_ID, "panel-a");
    expect(useTerminalStateStore.getState().panelTerminalStateByThreadId).toEqual({});
  });

  it("selectThreadSurfacePanes lists drawer then panel panes with stable single-surface results", () => {
    const store = useTerminalStateStore.getState();
    const empty = selectThreadSurfacePanes(useTerminalStateStore.getState(), THREAD_ID);
    expect(selectThreadSurfacePanes(useTerminalStateStore.getState(), OTHER_THREAD)).toBe(empty);
    store.newTerminal(THREAD_ID, "a");
    const state = useTerminalStateStore.getState();
    expect(selectThreadSurfacePanes(state, THREAD_ID)).toBe(drawer().terminalIds);
    store.newPanelTerminal(THREAD_ID, "panel-a");
    expect(selectThreadSurfacePanes(useTerminalStateStore.getState(), THREAD_ID)).toEqual([
      "a",
      "panel-a",
    ]);
    expect(selectThreadSurfacePanes(useTerminalStateStore.getState(), "")).toBe(empty);
  });
});

describe("restored panes", () => {
  beforeEach(resetTerminalStore);

  it("marks hydrated panes restored so they only reattach", () => {
    hydrate({ [THREAD_ID]: ["live", "dead"] });
    expect(drawer().restoredTerminalIds).toEqual(["live", "dead"]);
    expect(terminalPaneOpenOptions(THREAD_ID, "live")).toEqual({ attachOnly: true });
    expect(useTerminalStateStore.getState().restoredPanesAwaitingInventory).toBe(true);
  });

  it("drops restored panes absent from the first authoritative inventory only", () => {
    hydrate({ [THREAD_ID]: ["live", "dead"], [OTHER_THREAD]: ["gone"] });
    const store = useTerminalStateStore.getState();
    store.newTerminal(THREAD_ID, "fresh");
    store.reconcileTerminalInventory(inventory([[THREAD_ID, "live"]]));
    expect(drawer().terminalIds).toEqual(["live", "fresh"]);
    expect(drawer().restoredTerminalIds).toEqual(["live"]);
    expect(useTerminalStateStore.getState().terminalStateByThreadId[OTHER_THREAD]).toBeUndefined();
    expect(useTerminalStateStore.getState().restoredPanesAwaitingInventory).toBe(false);
    // Later inventories clear observations only; they never remove panes.
    store.reconcileTerminalInventory(inventory([]));
    expect(drawer().terminalIds).toEqual(["live", "fresh"]);
  });

  it("prunes at once when storage rehydrates after an inventory arrived", () => {
    useTerminalStateStore.getState().reconcileTerminalInventory(inventory([[THREAD_ID, "live"]]));
    hydrate({ [THREAD_ID]: ["live", "dead"] });
    expect(drawer().terminalIds).toEqual(["live"]);
    expect(useTerminalStateStore.getState().restoredPanesAwaitingInventory).toBe(false);
  });

  it("closes the surface when every restored pane is gone, leaving no implicit default", () => {
    hydrate({ [THREAD_ID]: ["default"] });
    useTerminalStateStore.getState().reconcileTerminalInventory(inventory([]));
    expect(drawer()).toMatchObject({ terminalIds: [], terminalOpen: false });
  });
});
