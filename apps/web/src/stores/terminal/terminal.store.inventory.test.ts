import { beforeEach, describe, expect, it } from "vitest";
import type { TerminalSessionInventory } from "@bigbud/contracts/workspace/terminal.stream.ts";

import { terminalEventBufferKey } from "./helpers.store";
import { useTerminalStateStore } from "./terminal.store";
import { makeTerminalEvent, resetTerminalStore, THREAD_ID } from "./terminal.store.test.helpers";

const inventory = (terminalIds: string[]): TerminalSessionInventory => ({
  type: "inventory",
  createdAt: "2026-04-02T20:00:02.000Z",
  sessions: terminalIds.map((terminalId) => ({ threadId: THREAD_ID, terminalId })),
});
const key = (terminalId: string) => terminalEventBufferKey(THREAD_ID, terminalId);

function observe(terminalId: string) {
  const store = useTerminalStateStore.getState();
  store.applyTerminalEvents([
    makeTerminalEvent("activity", { terminalId }),
    makeTerminalEvent("agentIdentity", { terminalId, provider: "pi", runtimeGeneration: "g1" }),
    makeTerminalEvent("output", { terminalId, data: "agent working" }),
  ]);
}

describe("authoritative subscription inventory", () => {
  beforeEach(resetTerminalStore);

  it("clears missing drawer/panel observations without exits, pane removal or metadata changes", () => {
    const store = useTerminalStateStore.getState();
    store.ensureTerminal(THREAD_ID, "drawer", { open: true });
    store.ensurePanelTerminal(THREAD_ID, "panel", { open: true });
    store.setTerminalLabelOverride(THREAD_ID, "drawer", "custom");
    store.setTerminalLaunchContext(THREAD_ID, { cwd: "/work", worktreePath: null });
    store.setTerminalLayout(THREAD_ID, "split");
    observe("drawer");
    observe("panel");
    const before = useTerminalStateStore.getState();
    store.reconcileTerminalInventory(inventory([]));
    const after = useTerminalStateStore.getState();
    expect(after.terminalStateByThreadId[THREAD_ID]?.runningTerminalIds).toEqual([]);
    expect(after.panelTerminalStateByThreadId[THREAD_ID]?.runningTerminalIds).toEqual([]);
    expect(after.terminalStateByThreadId[THREAD_ID]?.terminalIds).toEqual(["default", "drawer"]);
    expect(after.panelTerminalStateByThreadId[THREAD_ID]?.terminalIds).toEqual(["panel"]);
    expect(after.terminalStateByThreadId[THREAD_ID]?.terminalOpen).toBe(true);
    expect(after.terminalAgentProviderByKey).toEqual({});
    expect(after.terminalAgentVersionByKey).toEqual({});
    expect(after.terminalEventEntriesByKey).toEqual({});
    expect(after.terminalEventLastIdsByKey).toEqual({});
    expect(after.nextTerminalEventId).toBe(before.nextTerminalEventId);
    expect(after.terminalLabelOverridesByThreadId).toBe(before.terminalLabelOverridesByThreadId);
    expect(after.terminalLaunchContextByThreadId).toBe(before.terminalLaunchContextByThreadId);
    expect(after.terminalLayoutByThreadId).toBe(before.terminalLayoutByThreadId);
  });

  it("preserves all live client-derived WSL identity/activity and event buffers", () => {
    const store = useTerminalStateStore.getState();
    store.ensureTerminal(THREAD_ID, "wsl");
    observe("wsl");
    const before = useTerminalStateStore.getState();
    store.reconcileTerminalInventory(inventory(["wsl"]));
    expect(useTerminalStateStore.getState()).toBe(before);
    expect(before.terminalAgentProviderByKey[key("wsl")]).toBe("pi");
    expect(before.terminalStateByThreadId[THREAD_ID]?.runningTerminalIds).toEqual(["wsl"]);
  });

  it("does not erase a newer mounted-stream observation and accepts future starts for absent keys", () => {
    const store = useTerminalStateStore.getState();
    store.ensureTerminal(THREAD_ID, "new");
    observe("new");
    store.applyTerminalEvent(
      makeTerminalEvent("agentIdentity", {
        terminalId: "new",
        provider: "pi",
        createdAt: "2026-04-02T20:00:03.000Z",
      }),
    );
    store.reconcileTerminalInventory(inventory([]));
    expect(useTerminalStateStore.getState().terminalAgentProviderByKey[key("new")]).toBe("pi");
    store.reconcileTerminalInventory({ ...inventory([]), createdAt: "2026-04-02T20:00:04.000Z" });
    expect(useTerminalStateStore.getState().terminalAgentProviderByKey[key("new")]).toBeUndefined();
    store.applyTerminalEvent(
      makeTerminalEvent("agentIdentity", {
        terminalId: "new",
        provider: "opencode",
        runtimeGeneration: "g2",
        createdAt: "2026-04-02T20:00:05.000Z",
      }),
    );
    expect(useTerminalStateStore.getState().terminalAgentProviderByKey[key("new")]).toBe(
      "opencode",
    );
  });
});
