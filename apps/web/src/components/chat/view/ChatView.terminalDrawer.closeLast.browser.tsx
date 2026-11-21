import "../../../index.css";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { TerminalDrawerSwitchFixture } from "./ChatView.terminalDrawer.fixture";
import { useTerminalStateStore } from "../../../stores/terminal/terminal.store";
import { resetTerminalStore } from "../../../stores/terminal/terminal.store.test.helpers";

const mocks = vi.hoisted(() => ({
  open: vi.fn(async (input: { threadId: string; terminalId: string }) => ({
    ...input,
    dropPathMode: "posix",
    cwd: "/synthetic",
    worktreePath: null,
    status: "running",
    pid: 1,
    history: "ready\r\n",
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-11-21T00:00:00.000Z",
  })),
  resize: vi.fn(async () => undefined),
  write: vi.fn(async () => undefined),
  settings: {
    terminalFontFamily: "system-monospace",
    terminalFontSize: 12,
    terminalGpuAcceleration: "auto",
  },
}));
vi.mock("../../../rpc/nativeApi", () => ({ readNativeApi: () => ({ terminal: mocks }) }));
vi.mock("../../../hooks/useSettings", () => ({ useSettings: () => mocks.settings }));
vi.mock("~/config/env", () => ({ isElectron: false }));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useParams: () => "a",
}));
vi.mock("../../terminal/useThreadTerminalDrawer", async (original) => {
  const { useTerminalStateStore } = await import("../../../stores/terminal/terminal.store");
  const { selectThreadTerminalState } = await import("../../../stores/terminal/helpers.store");
  return {
    ...(await original<typeof import("../../terminal/useThreadTerminalDrawer")>()),
    useThreadTerminalDrawer: function useSyntheticDrawer(threadId: ThreadId) {
      const terminalState = useTerminalStateStore((state) =>
        selectThreadTerminalState(state.terminalStateByThreadId, threadId),
      );
      return {
        project: { id: "synthetic" },
        cwd: "/synthetic",
        terminalState,
        effectiveWorktreePath: null,
        runtimeEnv: {},
        terminalBaseLabel: threadId,
        terminalLabelOverrides: {},
        terminalProviderById: {},
        focusRequestId: 0,
        splitTerminal: vi.fn(),
        createNewTerminal: vi.fn(),
        activateTerminal: vi.fn(),
        closeTerminal: vi.fn(),
        setTerminalLabelOverride: vi.fn(),
        clearTerminalLabelOverride: vi.fn(),
        setTerminalHeight: vi.fn(),
      };
    },
  };
});

const frames = () =>
  new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));

it("closing the last pane removes the drawer body and spawns no terminal", async () => {
  resetTerminalStore();
  vi.clearAllMocks();
  const threadId = ThreadId.makeUnsafe("a");
  useTerminalStateStore.getState().newTerminal(threadId, "only");
  const screen = await render(<TerminalDrawerSwitchFixture />);
  try {
    await expect.poll(() => mocks.open.mock.calls.length, { timeout: 15000 }).toBe(1);
    expect(mocks.open.mock.calls[0]![0]).toMatchObject({ threadId: "a", terminalId: "only" });
    // Thread "b" has no panes, so its drawer renders nothing and opens nothing.
    expect(screen.container.querySelectorAll("[data-terminal-presentation]")).toHaveLength(1);

    useTerminalStateStore.getState().closeTerminal(threadId, "only");
    await expect
      .poll(() => screen.container.querySelectorAll("[data-terminal-presentation]").length)
      .toBe(0);
    for (let index = 0; index < 5; index += 1) await frames();
    expect(screen.container.querySelector(".xterm")).toBeNull();
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(useTerminalStateStore.getState().terminalStateByThreadId[threadId]).toBeUndefined();
  } finally {
    await screen.unmount();
    vi.restoreAllMocks();
    resetTerminalStore();
  }
});
