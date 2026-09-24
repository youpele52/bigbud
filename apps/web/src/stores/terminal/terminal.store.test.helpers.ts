import { ThreadId, type TerminalEvent } from "@bigbud/contracts";

import { useTerminalStateStore } from "./terminal.store";

export const THREAD_ID = ThreadId.makeUnsafe("thread-1");

export function makeTerminalEvent(
  type: TerminalEvent["type"],
  overrides: Partial<TerminalEvent> = {},
): TerminalEvent {
  const base = {
    threadId: THREAD_ID,
    terminalId: "default",
    createdAt: "2026-04-02T20:00:00.000Z",
  };

  switch (type) {
    case "output":
      return { ...base, type, data: "hello\n", ...overrides } as TerminalEvent;
    case "activity":
      return { ...base, type, hasRunningSubprocess: true, ...overrides } as TerminalEvent;
    case "agentIdentity":
      return { ...base, type, provider: null, ...overrides } as TerminalEvent;
    case "error":
      return { ...base, type, message: "boom", ...overrides } as TerminalEvent;
    case "cleared":
      return { ...base, type, ...overrides } as TerminalEvent;
    case "exited":
      return { ...base, type, exitCode: 0, exitSignal: null, ...overrides } as TerminalEvent;
    case "started":
    case "restarted":
      return {
        ...base,
        type,
        snapshot: {
          threadId: THREAD_ID,
          terminalId: "default",
          dropPathMode: "posix",
          cwd: "/tmp/workspace",
          worktreePath: null,
          status: "running",
          pid: 123,
          history: "",
          exitCode: null,
          exitSignal: null,
          updatedAt: "2026-04-02T20:00:00.000Z",
        },
        ...overrides,
      } as TerminalEvent;
  }
}

export function makeStartedTerminalEvent(terminalId: string): TerminalEvent {
  return makeTerminalEvent("started", {
    terminalId,
    snapshot: {
      threadId: THREAD_ID,
      terminalId,
      dropPathMode: "posix",
      cwd: "/tmp/worktree",
      worktreePath: "/tmp/worktree",
      status: "running",
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-04-02T20:00:00.000Z",
    },
  });
}

export function resetTerminalStore(): void {
  useTerminalStateStore.persist.clearStorage();
  useTerminalStateStore.setState({
    terminalStateByThreadId: {},
    panelTerminalStateByThreadId: {},
    terminalLabelOverridesByThreadId: {},
    terminalLaunchContextByThreadId: {},
    terminalEventEntriesByKey: {},
    terminalAgentProviderByKey: {},
    terminalAgentVersionByKey: {},
    terminalEventLastIdsByKey: {},
    nextTerminalEventId: 1,
  });
}
