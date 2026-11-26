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
    expect(terminalPersistenceOptions.version).toBe(2);
    expect(result.terminalLayoutByThreadId).toEqual({});
    expect(result.terminalStateByThreadId).toEqual({});
    expect(result.terminalWslDistributionByThreadId).toBe(old.terminalWslDistributionByThreadId);
    expect(result.terminalLabelOverridesByThreadId).toBe(old.terminalLabelOverridesByThreadId);
  });
});

describe("terminal pane hydration (v2)", () => {
  const legacy = {
    terminalOpen: true,
    terminalHeight: 300,
    terminalIds: ["default", "terminal-2"],
    runningTerminalIds: ["terminal-2"],
    activeTerminalId: "terminal-2",
    terminalGroups: [{ id: "group-default", terminalIds: ["default", "terminal-2"] }],
    activeTerminalGroupId: "group-default",
  };

  it("migrates v1 data unchanged and marks every hydrated pane restored", () => {
    const v1 = { terminalStateByThreadId: { a: legacy } };
    const migrated = terminalPersistenceOptions.migrate(v1);
    expect(migrated).toBe(v1);
    const result = terminalPersistenceOptions.merge(
      migrated,
      useTerminalStateStore.getInitialState(),
    );
    const pane = result.terminalStateByThreadId["a" as never];
    expect(pane?.terminalIds).toEqual(["default", "terminal-2"]);
    expect(pane?.restoredTerminalIds).toEqual(["default", "terminal-2"]);
    expect(pane?.terminalHeight).toBe(300);
    expect(result.restoredPanesAwaitingInventory).toBe(true);
  });

  it("drops corrupt and empty saved surfaces instead of inventing a default pane", () => {
    const result = terminalPersistenceOptions.merge(
      {
        terminalStateByThreadId: {
          a: { ...legacy, terminalIds: [] },
          b: { terminalIds: "default" },
          c: null,
        },
      },
      useTerminalStateStore.getInitialState(),
    );
    // Only the height preference survives; no pane is invented for the empty surface.
    expect(Object.keys(result.terminalStateByThreadId)).toEqual(["a"]);
    expect(result.terminalStateByThreadId["a" as never]).toMatchObject({
      terminalIds: [],
      terminalOpen: false,
      terminalHeight: 300,
    });
    expect(result.restoredPanesAwaitingInventory).toBe(false);
  });

  it("leaves in-memory panes user-created when storage holds no panes", () => {
    const current = {
      ...useTerminalStateStore.getInitialState(),
      terminalStateByThreadId: { a: { ...legacy, terminalIds: ["terminal-2"] } },
    } as never;
    const result = terminalPersistenceOptions.merge({}, current);
    expect(result.terminalStateByThreadId).toBe(
      (current as { terminalStateByThreadId: unknown }).terminalStateByThreadId,
    );
  });
});

describe("dismissed panes (v2)", () => {
  it("keeps old entries with a replacementId but never creates the replacement pane", () => {
    const result = terminalPersistenceOptions.merge(
      {
        dismissedTerminalPanes: {
          [JSON.stringify(["a", "only"])]: {
            threadId: "a",
            terminalId: "only",
            replacementId: "terminal-old",
          },
        },
        terminalStateByThreadId: {
          a: {
            terminalOpen: true,
            terminalHeight: 300,
            terminalIds: ["only"],
            runningTerminalIds: [],
            activeTerminalId: "only",
            terminalGroups: [],
            activeTerminalGroupId: "",
          },
        },
      },
      useTerminalStateStore.getInitialState(),
    );
    expect(Object.keys(result.dismissedTerminalPanes ?? {})).toHaveLength(1);
    expect(result.terminalStateByThreadId["a" as never]).toMatchObject({
      terminalIds: [],
      terminalOpen: false,
      terminalHeight: 300,
    });
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
