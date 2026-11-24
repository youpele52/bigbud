import type { NativeApi, ProjectId } from "@bigbud/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  open: new Set<string>(),
  closed: [] as string[],
  target: "ssh:host=dev-1&transport=direct-ssh",
}));

vi.mock("../../stores/main", () => ({
  useStore: {
    getState: () => ({
      projects: [{ id: "p1" }],
      sidebarThreadsById: { t1: { id: "t1", projectId: "p1" } },
    }),
  },
}));
vi.mock("../../lib/providerExecutionTargets", () => ({
  resolveWorkspaceExecutionTargetId: () => state.target,
}));
vi.mock("../../stores/terminal/helpers.store", () => ({
  selectThreadTerminalState: () => ({ terminalIds: [...state.open] }),
}));
vi.mock("../../stores/terminal", () => ({
  useTerminalStateStore: {
    getState: () => ({
      terminalStateByThreadId: {},
      panelTerminalStateByThreadId: {},
      closeTerminal: (_thread: string, id: string) => state.open.delete(id),
      closePanelTerminal: () => {},
    }),
  },
}));
vi.mock("../terminal/terminalLifecycle.operations", () => ({
  closeTerminalConfirmed: async (input: { terminalId: string; onConfirmed: () => void }) => {
    state.closed.push(input.terminalId);
    if (input.terminalId !== "stuck") input.onConfirmed();
  },
}));

import { closeTerminalsForConnectionChange } from "./Sidebar.remoteWorkspaceAddActions.edit.terminals";

const api = (answer: boolean) =>
  ({ dialogs: { confirm: vi.fn().mockResolvedValue(answer) } }) as unknown as NativeApi;
const run = (confirmAnswer: boolean, next = "ssh:host=dev-1&transport=agent") =>
  closeTerminalsForConnectionChange({
    api: api(confirmAnswer),
    projectId: "p1" as ProjectId,
    nextWorkspaceExecutionTargetId: next,
  });

beforeEach(() => {
  state.open = new Set(["term-1", "term-2"]);
  state.closed = [];
});

describe("closing terminals before a connection change", () => {
  it("asks once, closes every terminal, then lets the save continue", async () => {
    expect(await run(true)).toBeNull();
    expect(state.closed.toSorted()).toEqual(["term-1", "term-2"]);
    expect(state.open.size).toBe(0);
  });

  it("closes nothing and saves nothing when the user declines", async () => {
    expect(await run(false)).toMatch(/Nothing was saved/);
    expect(state.closed).toEqual([]);
  });

  it("does nothing when the connection is unchanged", async () => {
    expect(await run(true, state.target)).toBeNull();
    expect(state.closed).toEqual([]);
  });

  it("stops the save when a terminal could not be closed", async () => {
    state.open = new Set(["stuck"]);
    expect(await run(true)).toMatch(/could not be closed/);
  });
});
