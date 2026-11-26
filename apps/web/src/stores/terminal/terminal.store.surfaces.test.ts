import { ThreadId } from "@bigbud/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { selectThreadTerminalState } from "./helpers.store";
import { useTerminalStateStore } from "./terminal.store";
import { terminalPaneOpenOptions } from "./terminal.store.paneOrigin";
import { terminalPersistenceOptions } from "./terminal.store.persistence";
import {
  makeStartedTerminalEvent,
  resetTerminalStore,
  THREAD_ID,
} from "./terminal.store.test.helpers";

const store = () => useTerminalStateStore.getState();
const drawer = () => selectThreadTerminalState(store().terminalStateByThreadId, THREAD_ID);
const panel = () => store().panelTerminalStateByThreadId[THREAD_ID];

/** What a reload reads back: the persisted slice, merged into a fresh store. */
function reload() {
  const saved = JSON.parse(JSON.stringify(terminalPersistenceOptions.partialize(store())));
  resetTerminalStore();
  useTerminalStateStore.setState(terminalPersistenceOptions.merge(saved, store()));
}

beforeEach(resetTerminalStore);

describe("right-panel panes across a reload (plan W1)", () => {
  it("keeps a running panel terminal's pane, restored, and drops one the host no longer has", () => {
    store().newPanelTerminal(THREAD_ID, "panel-live");
    store().newPanelTerminal(THREAD_ID, "panel-dead");
    reload();
    expect(panel()?.terminalIds).toEqual(["panel-live", "panel-dead"]);
    // A restored panel pane only reattaches; it is never respawned.
    expect(terminalPaneOpenOptions(THREAD_ID, "panel-live")).toEqual({ attachOnly: true });
    store().reconcileTerminalInventory({
      type: "inventory",
      createdAt: "2026-11-22T00:00:00.000Z",
      sessions: [{ threadId: THREAD_ID, terminalId: "panel-live" }],
    });
    expect(panel()?.terminalIds).toEqual(["panel-live"]);
  });

  it("leaves panes created before an older save without a panel slice untouched", () => {
    store().newPanelTerminal(THREAD_ID, "panel-new");
    useTerminalStateStore.setState(
      terminalPersistenceOptions.merge({ terminalStateByThreadId: {} }, store()),
    );
    expect(panel()?.terminalIds).toEqual(["panel-new"]);
    expect(terminalPaneOpenOptions(THREAD_ID, "panel-new")).toEqual({});
  });
});

describe("terminals other clients start", () => {
  it("adds the pane without opening the drawer or taking the active tab", () => {
    store().applyTerminalEvent(makeStartedTerminalEvent("remote-1"));
    expect(drawer()).toMatchObject({ terminalIds: ["remote-1"], terminalOpen: false });
    store().newTerminal(THREAD_ID, "mine");
    store().setTerminalOpen(THREAD_ID, false);
    store().applyTerminalEvent(makeStartedTerminalEvent("remote-2"));
    expect(drawer()).toMatchObject({
      terminalIds: ["remote-1", "mine", "remote-2"],
      terminalOpen: false,
      activeTerminalId: "mine",
    });
    // A restart of a known pane changes nothing either.
    store().applyTerminalEvent(makeStartedTerminalEvent("remote-1"));
    expect(drawer()).toMatchObject({ terminalOpen: false, activeTerminalId: "mine" });
  });

  it("still opens and activates a setup script's terminal", () => {
    store().newTerminal(THREAD_ID, "mine");
    store().setTerminalOpen(THREAD_ID, false);
    store().applyTerminalEvent(makeStartedTerminalEvent("setup-bootstrap"));
    expect(drawer()).toMatchObject({ terminalOpen: true, activeTerminalId: "setup-bootstrap" });
  });

  it("never opens another thread's drawer", () => {
    const other = ThreadId.makeUnsafe("thread-other");
    store().applyTerminalEvent({
      ...makeStartedTerminalEvent("remote-3"),
      threadId: other,
    });
    expect(store().terminalStateByThreadId[other]?.terminalOpen).toBe(false);
  });
});
