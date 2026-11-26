import "../../index.css";

import { ThreadId } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useTerminalStateStore } from "../../stores/terminal/terminal.store";
import { useTerminalPanelStore } from "../../stores/terminal/terminalPanel.store";
import { resetTerminalStore } from "../../stores/terminal/terminal.store.test.helpers";

vi.mock("../../rpc/serverState", () => ({ useServerKeybindings: () => [] }));

vi.mock("./ThreadTerminalDrawer", () => ({
  default: (props: { threadId: string; terminalIds: string[] }) => (
    <div data-testid="thread-terminal-drawer">{`${props.threadId}:${props.terminalIds.join(",")}`}</div>
  ),
}));

vi.mock("./useThreadTerminalDrawer", async () => {
  const { selectThreadTerminalState, useTerminalStateStore: store } =
    await import("../../stores/terminal/terminal.store");
  return {
    useThreadTerminalDrawer: (threadId: string) => ({
      cwd: "/workspace",
      project: { id: "project-1", cwd: "/workspace" },
      executionTargetId: undefined,
      effectiveWorktreePath: null,
      runtimeEnv: {},
      focusRequestId: 0,
      terminalBaseLabel: "workspace",
      terminalLabelOverrides: {},
      terminalProviderById: {},
      terminalState: store((state) =>
        selectThreadTerminalState(state.panelTerminalStateByThreadId, threadId as never),
      ),
      splitTerminal: () => undefined,
      createNewTerminal: () => undefined,
      activateTerminal: () => undefined,
      closeTerminal: () => undefined,
      setTerminalLabelOverride: () => undefined,
      clearTerminalLabelOverride: () => undefined,
      setTerminalHeight: () => undefined,
      bumpFocusRequestId: () => undefined,
    }),
  };
});

import { TerminalPanelContent } from "./TerminalPanel";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

beforeEach(() => {
  resetTerminalStore();
  useTerminalPanelStore.setState({ open: true });
});
afterEach(() => useTerminalPanelStore.setState({ open: false }));

it("switching threads with the right panel open creates no terminal", async () => {
  const screen = await render(<TerminalPanelContent activeThreadId={THREAD_A} />);
  try {
    await expect.element(page.getByText("No terminal in this thread.")).toBeVisible();
    await screen.rerender(<TerminalPanelContent activeThreadId={THREAD_B} />);
    await screen.rerender(<TerminalPanelContent activeThreadId={THREAD_A} />);
    await nextFrame();
    await nextFrame();
    const state = useTerminalStateStore.getState();
    expect(state.panelTerminalStateByThreadId).toEqual({});
    expect(state.terminalStateByThreadId).toEqual({});
    expect(page.getByTestId("thread-terminal-drawer").query()).toBeNull();

    // Only the explicit action creates one, and only for the thread it was used on.
    await page.getByRole("button", { name: "New terminal" }).click();
    await expect
      .element(page.getByTestId("thread-terminal-drawer"))
      .toHaveTextContent(/^thread-a:/);
    await screen.rerender(<TerminalPanelContent activeThreadId={THREAD_B} />);
    await expect.element(page.getByText("No terminal in this thread.")).toBeVisible();
    await nextFrame();
    const after = useTerminalStateStore.getState();
    expect(Object.keys(after.panelTerminalStateByThreadId)).toEqual([THREAD_A]);
    expect(after.panelTerminalStateByThreadId[THREAD_A]?.terminalIds).toHaveLength(1);
    expect(after.terminalStateByThreadId).toEqual({});
  } finally {
    await screen.unmount();
  }
});
