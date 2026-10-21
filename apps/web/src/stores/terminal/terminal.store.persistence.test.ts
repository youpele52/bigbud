import { describe, expect, it } from "vitest";

import { useTerminalStateStore } from "./terminal.store";
import { terminalPersistenceOptions } from "./terminal.store.persistence";

describe("terminal layout hydration", () => {
  it.each([undefined, null, [], "terminal-only", 5])("ignores invalid layout map %j", (value) => {
    const current = useTerminalStateStore.getInitialState();
    const result = terminalPersistenceOptions.merge({ terminalLayoutByThreadId: value }, current);
    expect(result.terminalLayoutByThreadId).toEqual({});
    expect(result.setTerminalLayout).toBe(current.setTerminalLayout);
  });

  it("keeps valid modes and rejects corrupt or unknown entries", () => {
    const result = terminalPersistenceOptions.merge(
      {
        terminalLayoutByThreadId: {
          a: "split",
          b: "terminal-only",
          c: "chat-only",
          d: "future",
          e: null,
          f: {},
          "": "split",
        },
      },
      useTerminalStateStore.getInitialState(),
    );
    expect(result.terminalLayoutByThreadId).toEqual({
      a: "split",
      b: "terminal-only",
      c: "chat-only",
    });
  });

  it("keeps the v1 settings and defaults presentation when the new field is absent", () => {
    const current = useTerminalStateStore.getInitialState();
    const old = {
      terminalStateByThreadId: current.terminalStateByThreadId,
      terminalWslDistributionByThreadId: { a: "Ubuntu" },
      terminalLabelOverridesByThreadId: { a: { default: "Shell" } },
    };
    const result = terminalPersistenceOptions.merge(old, current);
    expect(terminalPersistenceOptions.version).toBe(1);
    expect(result.terminalLayoutByThreadId).toEqual({});
    expect(result.terminalStateByThreadId).toBe(old.terminalStateByThreadId);
    expect(result.terminalWslDistributionByThreadId).toBe(old.terminalWslDistributionByThreadId);
    expect(result.terminalLabelOverridesByThreadId).toBe(old.terminalLabelOverridesByThreadId);
  });
});

describe("terminal persistence write gating", () => {
  it("keeps every persisted slice identical across output-only event batches", () => {
    const store = useTerminalStateStore;
    const before = terminalPersistenceOptions.partialize(store.getState());
    store.getState().applyTerminalEvents([
      {
        type: "output",
        threadId: "thread-output-only",
        terminalId: "default",
        data: "frame",
        createdAt: new Date(0).toISOString(),
      },
    ]);
    const after = terminalPersistenceOptions.partialize(store.getState());
    for (const key of Object.keys(before) as Array<keyof typeof before>) {
      expect(after[key]).toBe(before[key]);
    }
  });
});
