import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTerminalStateStore } from "./terminal.store";
import { resetTerminalStore, THREAD_ID } from "./terminal.store.test.helpers";

const OTHER_THREAD = ThreadId.makeUnsafe("other-thread");

describe("saved terminal presentation", () => {
  beforeEach(resetTerminalStore);

  it("keeps independent selections without changing terminal sessions", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalOpen(THREAD_ID, true);
    const terminals = useTerminalStateStore.getState().terminalStateByThreadId;
    store.setTerminalLayout(THREAD_ID, "terminal-only");
    store.setTerminalLayout(OTHER_THREAD, "chat-only");
    expect(useTerminalStateStore.getState().terminalLayoutByThreadId).toEqual({
      [THREAD_ID]: "terminal-only",
      [OTHER_THREAD]: "chat-only",
    });
    expect(useTerminalStateStore.getState().terminalStateByThreadId).toBe(terminals);
  });

  it("persists presentation alongside the existing persisted terminal state", async () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalOpen(THREAD_ID, true);
    store.setTerminalLayout(THREAD_ID, "terminal-only");
    const persisted = useTerminalStateStore.persist.getOptions().partialize!(
      useTerminalStateStore.getState(),
    );
    expect(persisted).toHaveProperty("terminalLayoutByThreadId", {
      [THREAD_ID]: "terminal-only",
    });
    expect(persisted).toHaveProperty("terminalStateByThreadId", {
      [THREAD_ID]: useTerminalStateStore.getState().terminalStateByThreadId[THREAD_ID],
    });
    expect(useTerminalStateStore.getInitialState().terminalLayoutByThreadId).toEqual({});
    // Simulate a fresh runtime without overwriting the stored snapshot.
    const storage = useTerminalStateStore.persist.getOptions().storage!;
    const saved = await storage.getItem("bigbud:terminal-state:v1");
    useTerminalStateStore.setState({ terminalLayoutByThreadId: {}, terminalStateByThreadId: {} });
    await storage.setItem("bigbud:terminal-state:v1", saved!);
    await useTerminalStateStore.persist.rehydrate();
    expect(useTerminalStateStore.getState().terminalLayoutByThreadId[THREAD_ID]).toBe(
      "terminal-only",
    );
    expect(useTerminalStateStore.getState().terminalStateByThreadId[THREAD_ID]?.terminalOpen).toBe(
      true,
    );
  });

  it("does not notify or write storage on an identical selection", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalLayout(THREAD_ID, "chat-only");
    const notify = vi.fn();
    const unsubscribe = useTerminalStateStore.subscribe(notify);
    const write = vi.spyOn(useTerminalStateStore.persist.getOptions().storage!, "setItem");
    try {
      store.setTerminalLayout(THREAD_ID, "chat-only");
      expect(notify).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      write.mockRestore();
    }
  });

  it.each(["terminal-only", "chat-only", "split"] as const)(
    "resets %s after an external close/reopen without a mounted view",
    (mode) => {
      const store = useTerminalStateStore.getState();
      store.setTerminalOpen(THREAD_ID, true);
      store.setTerminalLayout(THREAD_ID, mode);
      store.setTerminalOpen(THREAD_ID, false);
      store.setTerminalOpen(THREAD_ID, true);
      expect(useTerminalStateStore.getState().terminalLayoutByThreadId[THREAD_ID]).toBeUndefined();
    },
  );

  it("preserves layout when closing a split or panel, resets after closing the last drawer pane", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "second");
    store.ensurePanelTerminal(THREAD_ID, "panel");
    store.setTerminalLayout(THREAD_ID, "terminal-only");
    store.closePanelTerminal(THREAD_ID, "panel");
    store.closeTerminal(THREAD_ID, "second");
    expect(useTerminalStateStore.getState().terminalLayoutByThreadId[THREAD_ID]).toBe(
      "terminal-only",
    );
    store.closeTerminal(THREAD_ID, "default");
    expect(useTerminalStateStore.getState().terminalLayoutByThreadId[THREAD_ID]).toBeUndefined();
  });

  it.each(["clearTerminalState", "removeTerminalState"] as const)(
    "%s removes presentation even without a terminal state entry",
    (action) => {
      const store = useTerminalStateStore.getState();
      store.setTerminalLayout(THREAD_ID, "chat-only");
      store.setTerminalLayout(OTHER_THREAD, "terminal-only");
      store[action](THREAD_ID);
      expect(useTerminalStateStore.getState().terminalLayoutByThreadId).toEqual({
        [OTHER_THREAD]: "terminal-only",
      });
    },
  );

  it("prunes orphaned selections without touching active threads", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalLayout(THREAD_ID, "chat-only");
    store.setTerminalLayout(OTHER_THREAD, "terminal-only");
    store.removeOrphanedTerminalStates(new Set([THREAD_ID]));
    expect(useTerminalStateStore.getState().terminalLayoutByThreadId).toEqual({
      [THREAD_ID]: "chat-only",
    });
  });
});
