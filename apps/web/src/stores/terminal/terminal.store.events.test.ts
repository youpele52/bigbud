import { beforeEach, describe, expect, it } from "vitest";

import {
  selectTerminalEventEntries,
  selectTerminalEventLastId,
  selectThreadTerminalState,
  terminalEventBufferKey,
} from "./helpers.store";
import { useTerminalStateStore } from "./terminal.store";
import {
  makeStartedTerminalEvent,
  makeTerminalEvent,
  resetTerminalStore,
  THREAD_ID,
} from "./terminal.store.test.helpers";

describe("terminalStateStore events", () => {
  beforeEach(resetTerminalStore);

  it("keeps live agent identity after output evicts old events and clears it on close", () => {
    const store = useTerminalStateStore.getState();
    const key = terminalEventBufferKey(THREAD_ID, "default");
    store.applyTerminalEvent(makeTerminalEvent("agentIdentity", { provider: "pi" }));
    for (let index = 0; index < 205; index += 1) {
      store.applyTerminalEvent(makeTerminalEvent("output"));
    }
    expect(useTerminalStateStore.getState().terminalAgentProviderByKey[key]).toBe("pi");

    store.applyTerminalEvent(
      makeTerminalEvent("agentIdentity", {
        provider: "opencode",
        createdAt: "2026-04-02T20:00:01.000Z",
      }),
    );
    expect(useTerminalStateStore.getState().terminalAgentProviderByKey[key]).toBe("opencode");

    store.closeTerminal(THREAD_ID, "default");
    expect(Object.hasOwn(useTerminalStateStore.getState().terminalAgentProviderByKey, key)).toBe(
      false,
    );
  });

  it("clears the icon identity on terminal exit without changing its custom label", () => {
    const store = useTerminalStateStore.getState();
    const key = terminalEventBufferKey(THREAD_ID, "default");
    store.setTerminalLabelOverride(THREAD_ID, "default", "work shell");
    store.applyTerminalEvent(makeTerminalEvent("agentIdentity", { provider: "pi" }));
    store.applyTerminalEvent(
      makeTerminalEvent("exited", { createdAt: "2026-04-02T20:00:01.000Z" }),
    );
    expect(useTerminalStateStore.getState().terminalAgentProviderByKey[key]).toBeNull();
    expect(
      useTerminalStateStore.getState().terminalLabelOverridesByThreadId[THREAD_ID]?.default,
    ).toBe("work shell");
  });

  it("hydrates a reopened pane from the snapshot without reviving older output", () => {
    const store = useTerminalStateStore.getState();
    const key = terminalEventBufferKey(THREAD_ID, "default");
    store.applyTerminalEvent(makeTerminalEvent("output", { data: "pi v0.80.3\n" }));
    store.hydrateTerminalAgentFromSnapshot({
      threadId: THREAD_ID,
      terminalId: "default",
      executionTargetId: "local",
      dropPathMode: "posix",
      cwd: "/tmp/workspace",
      worktreePath: null,
      status: "running",
      pid: 123,
      activeAgentProvider: "opencode",
      history: "pi v0.80.3\n",
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-04-02T20:00:01.000Z",
    });
    expect(useTerminalStateStore.getState().terminalAgentProviderByKey[key]).toBe("opencode");
  });

  it("keeps an identity event newer than the terminal.open snapshot", () => {
    const store = useTerminalStateStore.getState();
    const key = terminalEventBufferKey(THREAD_ID, "default");
    store.applyTerminalEvent(
      makeTerminalEvent("agentIdentity", {
        provider: "opencode",
        createdAt: "2026-04-02T20:00:02.000Z",
      }),
    );
    store.hydrateTerminalAgentFromSnapshot({
      threadId: THREAD_ID,
      terminalId: "default",
      executionTargetId: "local",
      dropPathMode: "posix",
      cwd: "/tmp/workspace",
      worktreePath: null,
      status: "running",
      pid: 123,
      activeAgentProvider: "pi",
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-04-02T20:00:01.000Z",
    });
    expect(useTerminalStateStore.getState().terminalAgentProviderByKey[key]).toBe("opencode");
  });

  it("drops local identity when the reopened pane now targets a remote host", () => {
    const store = useTerminalStateStore.getState();
    const key = terminalEventBufferKey(THREAD_ID, "default");
    store.applyTerminalEvent(makeTerminalEvent("agentIdentity", { provider: "pi" }));
    store.hydrateTerminalAgentFromSnapshot({
      threadId: THREAD_ID,
      terminalId: "default",
      executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
      dropPathMode: "posix",
      cwd: "/home/root/workspace",
      worktreePath: null,
      status: "running",
      pid: 456,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-04-02T20:00:01.000Z",
    });
    expect(Object.hasOwn(useTerminalStateStore.getState().terminalAgentProviderByKey, key)).toBe(
      false,
    );
  });

  it("buffers terminal events outside persisted terminal UI state", () => {
    const store = useTerminalStateStore.getState();
    store.recordTerminalEvent(makeTerminalEvent("output"));
    store.recordTerminalEvent(makeTerminalEvent("activity"));

    const entries = selectTerminalEventEntries(
      useTerminalStateStore.getState().terminalEventEntriesByKey,
      THREAD_ID,
      "default",
    );

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.id)).toEqual([1, 2]);
    expect(entries.map((entry) => entry.event.type)).toEqual(["output", "activity"]);
    expect(
      selectTerminalEventLastId(
        useTerminalStateStore.getState().terminalEventLastIdsByKey,
        THREAD_ID,
        "default",
      ),
    ).toBe(2);
  });

  it("applies started terminal events to terminal state, launch context, and event buffer", () => {
    const store = useTerminalStateStore.getState();
    store.applyTerminalEvent(makeStartedTerminalEvent("setup-bootstrap"));

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    const entries = selectTerminalEventEntries(
      useTerminalStateStore.getState().terminalEventEntriesByKey,
      THREAD_ID,
      "setup-bootstrap",
    );

    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.activeTerminalId).toBe("setup-bootstrap");
    expect(terminalState.terminalIds).toEqual(["default", "setup-bootstrap"]);
    expect(useTerminalStateStore.getState().terminalLaunchContextByThreadId[THREAD_ID]).toEqual({
      cwd: "/tmp/worktree",
      worktreePath: "/tmp/worktree",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.event.type).toBe("started");
  });

  it("applies activity and exited terminal events to subprocess state while buffering events", () => {
    const store = useTerminalStateStore.getState();
    store.ensureTerminal(THREAD_ID, "terminal-2", { open: true, active: true });

    store.applyTerminalEvent(
      makeTerminalEvent("activity", {
        terminalId: "terminal-2",
        hasRunningSubprocess: true,
      }),
    );
    expect(
      selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, THREAD_ID)
        .runningTerminalIds,
    ).toEqual(["terminal-2"]);

    store.applyTerminalEvent(
      makeTerminalEvent("exited", {
        terminalId: "terminal-2",
        createdAt: "2026-04-02T20:00:01.000Z",
        exitCode: 0,
        exitSignal: null,
      }),
    );

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    const entries = selectTerminalEventEntries(
      useTerminalStateStore.getState().terminalEventEntriesByKey,
      THREAD_ID,
      "terminal-2",
    );

    expect(terminalState.runningTerminalIds).toEqual([]);
    expect(entries.map((entry) => entry.event.type)).toEqual(["activity", "exited"]);
  });

  it("applies terminal event batches in order", () => {
    const store = useTerminalStateStore.getState();
    store.ensureTerminal(THREAD_ID, "terminal-2", { open: true, active: true });

    store.applyTerminalEvents([
      makeTerminalEvent("activity", {
        terminalId: "terminal-2",
        hasRunningSubprocess: true,
      }),
      makeTerminalEvent("exited", {
        terminalId: "terminal-2",
        createdAt: "2026-04-02T20:00:01.000Z",
        exitCode: 0,
        exitSignal: null,
      }),
    ]);

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    const entries = selectTerminalEventEntries(
      useTerminalStateStore.getState().terminalEventEntriesByKey,
      THREAD_ID,
      "terminal-2",
    );

    expect(terminalState.runningTerminalIds).toEqual([]);
    expect(entries.map((entry) => entry.event.type)).toEqual(["activity", "exited"]);
  });

  it("routes panel terminal events to panel state without adding them to drawer state", () => {
    const store = useTerminalStateStore.getState();
    store.ensurePanelTerminal(THREAD_ID, "panel-terminal-1", { active: true });

    store.applyTerminalEvent(makeStartedTerminalEvent("panel-terminal-1"));
    store.applyTerminalEvent(
      makeTerminalEvent("activity", {
        terminalId: "panel-terminal-1",
        hasRunningSubprocess: true,
      }),
    );

    const drawerTerminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    const panelTerminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().panelTerminalStateByThreadId,
      THREAD_ID,
    );
    const entries = selectTerminalEventEntries(
      useTerminalStateStore.getState().terminalEventEntriesByKey,
      THREAD_ID,
      "panel-terminal-1",
    );

    expect(drawerTerminalState.terminalIds).toEqual(["default"]);
    expect(panelTerminalState.terminalIds).toEqual(["panel-terminal-1"]);
    expect(panelTerminalState.runningTerminalIds).toEqual(["panel-terminal-1"]);
    expect(entries.map((entry) => entry.event.type)).toEqual(["started", "activity"]);
  });

  it("clears buffered terminal events when a thread terminal state is removed", () => {
    const store = useTerminalStateStore.getState();
    store.recordTerminalEvent(makeTerminalEvent("output"));
    store.removeTerminalState(THREAD_ID);

    const entries = selectTerminalEventEntries(
      useTerminalStateStore.getState().terminalEventEntriesByKey,
      THREAD_ID,
      "default",
    );

    expect(entries).toEqual([]);
    expect(
      selectTerminalEventLastId(
        useTerminalStateStore.getState().terminalEventLastIdsByKey,
        THREAD_ID,
        "default",
      ),
    ).toBe(0);
  });

  it("is a no-op when clearing terminal state for a thread with no state or buffered events", () => {
    const store = useTerminalStateStore.getState();
    const before = useTerminalStateStore.getState();

    store.clearTerminalState(THREAD_ID);

    expect(useTerminalStateStore.getState()).toBe(before);
  });
});
