import { beforeEach, describe, expect, it } from "vitest";

import { useTerminalStateStore } from "./terminal.store";
import { resolveTerminalAgentKind } from "./terminal.store.agentKind";
import { selectThreadTerminalProvider } from "./terminal.store.recentAgent";
import { makeTerminalEvent, resetTerminalStore, THREAD_ID } from "./terminal.store.test.helpers";

const herdr = { id: "herdr", names: ["herdr"] };

describe("resolveTerminalAgentKind", () => {
  it("prefers a native provider and fills in only terminal-only exceptions", () => {
    expect(resolveTerminalAgentKind("pi", herdr)).toBe("pi");
    expect(resolveTerminalAgentKind(null, herdr)).toBe("herdr");
    expect(resolveTerminalAgentKind(undefined, herdr)).toBe("herdr");
    expect(resolveTerminalAgentKind(null, { id: "gemini", names: ["Gemini"] })).toBeNull();
    expect(resolveTerminalAgentKind(null, null)).toBeNull();
    expect(resolveTerminalAgentKind(undefined, undefined)).toBeUndefined();
  });
});

describe("terminal-only agent identity", () => {
  beforeEach(resetTerminalStore);

  it("shows herdr as the thread's terminal identity and clears it on exit", () => {
    const store = useTerminalStateStore.getState();
    store.applyTerminalEvent(makeTerminalEvent("agentIdentity", { provider: null, agent: herdr }));
    expect(selectThreadTerminalProvider(useTerminalStateStore.getState(), THREAD_ID)).toBe("herdr");
    store.applyTerminalEvent(
      makeTerminalEvent("agentIdentity", {
        provider: null,
        agent: null,
        createdAt: "2026-04-02T20:00:01.000Z",
      }),
    );
    expect(selectThreadTerminalProvider(useTerminalStateStore.getState(), THREAD_ID)).toBeNull();
  });

  it("keeps unlisted terminal-only agents without a logo", () => {
    useTerminalStateStore.getState().applyTerminalEvent(
      makeTerminalEvent("agentIdentity", {
        provider: null,
        agent: { id: "aider", names: ["Aider"] },
      }),
    );
    expect(selectThreadTerminalProvider(useTerminalStateStore.getState(), THREAD_ID)).toBeNull();
  });
});
