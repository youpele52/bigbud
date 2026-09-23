import { type TerminalSessionSnapshot } from "@bigbud/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { terminalEventBufferKey } from "./helpers.store";
import { useTerminalStateStore } from "./terminal.store";
import { makeTerminalEvent, resetTerminalStore, THREAD_ID } from "./terminal.store.test.helpers";

const KEY = terminalEventBufferKey(THREAD_ID, "default");
const START = "2026-04-02T20:00:00.000Z";
const PI = "2026-04-02T20:00:01.000Z";
const EXIT = "2026-04-02T20:00:02.000Z";
const NEXT = "2026-04-02T20:00:03.000Z";

function snapshot(overrides: Partial<TerminalSessionSnapshot> = {}): TerminalSessionSnapshot {
  return {
    threadId: THREAD_ID,
    terminalId: "default",
    executionTargetId: "local",
    dropPathMode: "posix",
    cwd: "/tmp/workspace",
    worktreePath: null,
    status: "running",
    pid: 123,
    runtimeGeneration: "run-1",
    activeAgentProvider: null,
    history: "",
    exitCode: null,
    exitSignal: null,
    updatedAt: START,
    ...overrides,
  };
}

function start(generation = "run-1", at = START): void {
  useTerminalStateStore.getState().applyTerminalEvent(
    makeTerminalEvent("started", {
      createdAt: at,
      snapshot: snapshot({ runtimeGeneration: generation, updatedAt: at }),
    }),
  );
}

function agent(provider: "pi" | "opencode", at: string, generation = "run-1"): void {
  useTerminalStateStore.getState().applyTerminalEvent(
    makeTerminalEvent("agentIdentity", {
      createdAt: at,
      runtimeGeneration: generation,
      provider,
    }),
  );
}

describe("terminal agent identity ordering", () => {
  beforeEach(resetTerminalStore);

  it("rejects an older identity delivered after exit", () => {
    start();
    agent("pi", PI);
    const store = useTerminalStateStore.getState();
    store.applyTerminalEvent(
      makeTerminalEvent("exited", {
        createdAt: EXIT,
        runtimeGeneration: "run-1",
      }),
    );
    agent("pi", PI);

    expect(useTerminalStateStore.getState().terminalAgentProviderByKey[KEY]).toBeNull();
    expect(useTerminalStateStore.getState().terminalAgentVersionByKey[KEY]).toMatchObject({
      updatedAt: EXIT,
      status: "terminated",
    });
  });

  it("keeps a close tombstone until a new runtime starts", () => {
    start();
    agent("pi", PI);
    const store = useTerminalStateStore.getState();
    store.setTerminalLabelOverride(THREAD_ID, "default", "work shell");
    store.closeTerminal(THREAD_ID, "default");
    agent("pi", NEXT, "run-1");
    store.hydrateTerminalAgentFromSnapshot(
      snapshot({ activeAgentProvider: "pi", updatedAt: NEXT }),
    );

    expect(Object.hasOwn(useTerminalStateStore.getState().terminalAgentProviderByKey, KEY)).toBe(
      false,
    );
    expect(useTerminalStateStore.getState().terminalAgentVersionByKey[KEY]?.status).toBe("closed");

    start("run-2", "2026-04-02T20:00:04.000Z");
    agent("opencode", "2026-04-02T20:00:05.000Z", "run-2");
    agent("pi", "2026-04-02T20:00:06.000Z", "run-1");
    expect(useTerminalStateStore.getState().terminalAgentProviderByKey[KEY]).toBe("opencode");
    expect(
      useTerminalStateStore.getState().terminalLabelOverridesByThreadId[THREAD_ID]?.default,
    ).toBe("work shell");
  });

  it("retains a newer identity when its event has left the 200-event buffer", () => {
    start();
    agent("opencode", EXIT);
    const store = useTerminalStateStore.getState();
    for (let index = 0; index < 205; index += 1) {
      store.applyTerminalEvent(
        makeTerminalEvent("output", { createdAt: NEXT, data: `line ${index}\n` }),
      );
    }
    expect(
      useTerminalStateStore
        .getState()
        .terminalEventEntriesByKey[KEY]?.some((entry) => entry.event.type === "agentIdentity"),
    ).toBe(false);

    store.hydrateTerminalAgentFromSnapshot(snapshot({ activeAgentProvider: "pi", updatedAt: PI }));
    expect(useTerminalStateStore.getState().terminalAgentProviderByKey[KEY]).toBe("opencode");
    expect(useTerminalStateStore.getState().terminalAgentVersionByKey[KEY]?.updatedAt).toBe(EXIT);
  });

  it("retains a newer exit after its event has left the buffer", () => {
    start();
    agent("pi", PI);
    const store = useTerminalStateStore.getState();
    store.applyTerminalEvent(
      makeTerminalEvent("exited", {
        createdAt: EXIT,
        runtimeGeneration: "run-1",
      }),
    );
    for (let index = 0; index < 205; index += 1) {
      store.recordTerminalEvent(makeTerminalEvent("output", { data: `line ${index}\n` }));
    }
    store.hydrateTerminalAgentFromSnapshot(snapshot({ activeAgentProvider: "pi", updatedAt: PI }));
    expect(useTerminalStateStore.getState().terminalAgentProviderByKey[KEY]).toBeNull();
    expect(useTerminalStateStore.getState().terminalAgentVersionByKey[KEY]?.status).toBe(
      "terminated",
    );
  });

  it("retains a newer shell identity after its event has left the buffer", () => {
    start();
    agent("pi", PI);
    const store = useTerminalStateStore.getState();
    store.applyTerminalEvent(
      makeTerminalEvent("agentIdentity", {
        createdAt: EXIT,
        runtimeGeneration: "run-1",
        provider: null,
      }),
    );
    for (let index = 0; index < 205; index += 1) {
      store.applyTerminalEvent(
        makeTerminalEvent("output", { createdAt: NEXT, data: `line ${index}\n` }),
      );
    }
    store.hydrateTerminalAgentFromSnapshot(snapshot({ activeAgentProvider: "pi", updatedAt: PI }));
    expect(useTerminalStateStore.getState().terminalAgentProviderByKey[KEY]).toBeNull();
    expect(useTerminalStateStore.getState().terminalAgentVersionByKey[KEY]?.status).toBe("running");
  });

  it("rejects a retired runtime after a restart even if delivered later", () => {
    start();
    agent("pi", PI);
    start("run-2", EXIT);
    agent("pi", "2026-04-02T20:00:04.000Z", "run-1");
    expect(useTerminalStateStore.getState().terminalAgentProviderByKey[KEY]).toBeNull();
    agent("opencode", "2026-04-02T20:00:05.000Z", "run-2");
    useTerminalStateStore.getState().applyTerminalEvent(
      makeTerminalEvent("exited", {
        createdAt: "2026-04-02T20:00:06.000Z",
        runtimeGeneration: "run-1",
      }),
    );
    expect(useTerminalStateStore.getState().terminalAgentProviderByKey[KEY]).toBe("opencode");
  });

  it("keeps a new identity if its start event arrives afterward", () => {
    start();
    agent("pi", PI);
    agent("opencode", NEXT, "run-2");
    start("run-2", EXIT);
    expect(useTerminalStateStore.getState().terminalAgentProviderByKey[KEY]).toBe("opencode");
    expect(useTerminalStateStore.getState().terminalAgentVersionByKey[KEY]?.updatedAt).toBe(NEXT);
  });
});
