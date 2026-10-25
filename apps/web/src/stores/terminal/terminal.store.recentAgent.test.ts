import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTerminalStateStore } from "./terminal.store";
import { selectThreadTerminalProvider } from "./terminal.store.recentAgent";
import { makeTerminalEvent, resetTerminalStore, THREAD_ID } from "./terminal.store.test.helpers";

const at = (second: number) => `2026-10-24T12:00:${String(second).padStart(2, "0")}.000Z`;
const store = () => useTerminalStateStore.getState();
const provider = () => selectThreadTerminalProvider(store(), THREAD_ID);

function agent(terminalId: string, provider: "pi" | "claudeAgent" | null, second: number) {
  store().applyTerminalEvent(
    makeTerminalEvent("agentIdentity", {
      terminalId,
      provider,
      createdAt: at(second),
      runtimeGeneration: terminalId,
    }),
  );
}

describe("recent running terminal provider", () => {
  beforeEach(resetTerminalStore);

  it("selects the most recently detected agent across drawer and panel panes", () => {
    expect(provider()).toBeNull();
    store().ensurePanelTerminal(THREAD_ID, "panel", { active: true });
    agent("default", "claudeAgent", 1);
    agent("panel", "pi", 2);
    expect(provider()).toBe("pi");
    agent("default", "pi", 3);
    agent("default", "claudeAgent", 4);
    expect(provider()).toBe("claudeAgent");
  });

  it("uses server timestamps rather than event arrival order and isolates threads", () => {
    agent("newer", "pi", 4);
    agent("older", "claudeAgent", 1);
    store().applyTerminalEvent(
      makeTerminalEvent("agentIdentity", {
        threadId: ThreadId.makeUnsafe("other"),
        provider: "claudeAgent",
        createdAt: at(5),
      }),
    );
    expect(provider()).toBe("pi");
  });

  it("tracks input to an older running agent without updating on every keystroke", () => {
    agent("default", "claudeAgent", 1);
    agent("panel", "pi", 2);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(at(3));
      store().markTerminalAgentActive(THREAD_ID, "default");
      expect(provider()).toBe("claudeAgent");
      const activeState = store();
      store().markTerminalAgentActive(THREAD_ID, "default");
      expect(store()).toBe(activeState);
      // Input recency must not change the lifecycle timestamp used to reject stale identities.
      agent("default", null, 2);
      expect(provider()).toBe("pi");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let shell input or background output take over the icon", () => {
    agent("default", "claudeAgent", 1);
    agent("panel", "pi", 2);
    store().markTerminalAgentActive(THREAD_ID, "shell");
    store().applyTerminalEvent(
      makeTerminalEvent("output", { terminalId: "default", createdAt: at(3), data: "redraw" }),
    );
    expect(provider()).toBe("pi");
  });

  it("does not let a fast client clock hide subsequent provider switches", () => {
    agent("default", "claudeAgent", 1);
    agent("panel", "pi", 2);
    vi.useFakeTimers();
    try {
      vi.setSystemTime("2030-01-01T00:00:00.000Z");
      store().markTerminalAgentActive(THREAD_ID, "default");
      expect(provider()).toBe("claudeAgent");
      agent("panel", "claudeAgent", 3);
      agent("panel", "pi", 4);
      expect(provider()).toBe("pi");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a live snapshot without reviving an older identity after exit", () => {
    const snapshot = {
      threadId: THREAD_ID,
      terminalId: "default",
      dropPathMode: "posix" as const,
      cwd: "/workspace",
      worktreePath: null,
      status: "running" as const,
      pid: 123,
      runtimeGeneration: "default",
      activeAgentProvider: "pi" as const,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: at(1),
    };
    store().hydrateTerminalAgentFromSnapshot(snapshot);
    expect(provider()).toBe("pi");
    store().applyTerminalEvent(
      makeTerminalEvent("exited", { createdAt: at(2), runtimeGeneration: "default" }),
    );
    store().hydrateTerminalAgentFromSnapshot(snapshot);
    expect(provider()).toBeNull();
  });

  it.each(["exited", "error", "shell", "close"] as const)(
    "falls back to another running agent on %s and hides when none remain",
    (end) => {
      agent("default", "claudeAgent", 1);
      agent("panel", "pi", 2);
      if (end === "close") store().closePanelTerminal(THREAD_ID, "panel");
      else if (end === "shell") agent("panel", null, 3);
      else
        store().applyTerminalEvent(
          makeTerminalEvent(end, {
            terminalId: "panel",
            runtimeGeneration: "panel",
            createdAt: at(3),
          }),
        );
      expect(provider()).toBe("claudeAgent");
      agent("panel", "pi", 2); // Late identity cannot revive the exited agent.
      expect(provider()).toBe("claudeAgent");
      agent("default", null, 4);
      expect(provider()).toBeNull();
    },
  );

  it("retains identity outside the output buffer and removes it with the thread", () => {
    agent("default", "pi", 1);
    for (let index = 0; index < 205; index++)
      store().applyTerminalEvent(makeTerminalEvent("output", { createdAt: at(2) }));
    expect(provider()).toBe("pi");
    store().removeTerminalState(THREAD_ID);
    expect(provider()).toBeNull();
  });
});
