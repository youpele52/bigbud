import type { ThreadId } from "@bigbud/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render, renderHook } from "vitest-browser-react";
import { ThreadTerminalDrawerToolbar } from "./ThreadTerminalDrawerToolbar";
import { useTerminalStateStore } from "../../stores/terminal";
import { recordTerminalLaunch, forgetTerminalLaunch } from "../../lib/terminalLaunchBinding";
import { useThreadTerminalDrawer } from "./useThreadTerminalDrawer";

const mocks = vi.hoisted(() => ({
  workspace: "local",
  distributions: vi.fn(),
  open: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock("../../stores/main", () => ({
  useThreadById: () => ({ projectId: "project", workspaceExecutionTargetId: mocks.workspace }),
  useProjectById: () => ({ cwd: "C:\\project", workspaceExecutionTargetId: mocks.workspace }),
}));
vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => ({
    terminal: { wslDistributions: mocks.distributions, open: mocks.open },
    orchestration: { dispatchCommand: mocks.dispatch },
  }),
}));
vi.mock("../../rpc/serverState", () => ({
  useServerSettings: () => ({ defaultChatCwd: "~/Documents" }),
}));

const threadId = "picker-chat" as ThreadId;
const props = {
  threadId,
  hasReachedSplitLimit: false,
  resolvedActiveTerminalId: "active",
  renameTerminalActionLabel: "Rename",
  splitTerminalActionLabel: "Split",
  newTerminalActionLabel: "New",
  closeTerminalActionLabel: "Close",
  onRenameTerminalAction: () => undefined,
  onSplitTerminalAction: () => undefined,
  onNewTerminalAction: () => undefined,
  onCloseTerminal: () => undefined,
};
beforeEach(() => {
  mocks.workspace = "local";
  vi.clearAllMocks();
  mocks.distributions.mockResolvedValue({
    supported: true,
    distributions: ["Ubuntu dev", "Other"],
  });
  useTerminalStateStore.getState().setTerminalWslDistribution(threadId, null);
});
afterEach(() => {
  useTerminalStateStore.getState().removeTerminalState(threadId);
  forgetTerminalLaunch(threadId, "active");
});

it.each(["drawer", "panel"] as const)(
  "%s split/new launch contexts follow the shared selection without starting AI",
  async (mode) => {
    const hook = await renderHook(() => useThreadTerminalDrawer(threadId, null, true, mode));
    try {
      useTerminalStateStore.getState().setTerminalWslDistribution(threadId, "Ubuntu dev");
      await expect.poll(() => hook.result.current.executionTargetId).toBe("wsl:Ubuntu%20dev");
      expect(hook.result.current.cwd).toBe("C:\\project");
      expect(hook.result.current.runtimeEnv).toEqual({ T3CODE_PROJECT_ROOT: "C:\\project" });
      const previous = hook.result.current.terminalState.terminalIds.length;
      hook.result.current.splitTerminal();
      await expect
        .poll(() => hook.result.current.terminalState.terminalIds.length)
        .toBe(previous + 1);
      hook.result.current.createNewTerminal();
      await expect
        .poll(() => hook.result.current.terminalState.terminalIds.length)
        .toBe(previous + 2);
      expect(hook.result.current.executionTargetId).toBe("wsl:Ubuntu%20dev");
      expect(mocks.open).not.toHaveBeenCalled();
      expect(mocks.dispatch).not.toHaveBeenCalled();
    } finally {
      await hook.unmount();
    }
  },
);

it.each(["floating", "sidebar"] as const)(
  "%s toolbar persists per-chat new target separately from the active Linux identity",
  async (variant) => {
    const screen = await render(<ThreadTerminalDrawerToolbar {...props} variant={variant} />);
    try {
      await expect
        .element(page.getByRole("button", { name: "New terminal target" }))
        .toBeInTheDocument();
      recordTerminalLaunch({
        threadId,
        terminalId: "active",
        executionTargetId: "wsl:Other",
        wslIdentity: { distribution: "Other", username: "root", uid: 0 },
        cwd: "/root",
        worktreePath: null,
        runtimeEnv: {},
        dropPathMode: "posix",
        status: "running",
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: "now",
      });
      await page.getByRole("button", { name: "New terminal target" }).click();
      await expect
        .element(page.getByLabelText("Active terminal target"))
        .toHaveTextContent("Other · root (uid 0)");
      await page.getByRole("menuitem", { name: "WSL: Ubuntu dev" }).click();
      expect(useTerminalStateStore.getState().terminalWslDistributionByThreadId[threadId]).toBe(
        "Ubuntu dev",
      );
      await screen.rerender(
        <ThreadTerminalDrawerToolbar
          {...props}
          variant={variant === "floating" ? "sidebar" : "floating"}
        />,
      );
      await page.getByRole("button", { name: "New terminal target" }).click();
      await expect
        .element(page.getByLabelText("Selected new terminal target"))
        .toHaveTextContent("New: Ubuntu dev");
      await expect
        .element(page.getByLabelText("Active terminal target"))
        .toHaveTextContent("Other · root (uid 0)");
      expect(mocks.open).not.toHaveBeenCalled();
      expect(mocks.dispatch).not.toHaveBeenCalled();
      await page.getByRole("menuitem", { name: "Chat workspace", exact: true }).click();
      expect(
        useTerminalStateStore.getState().terminalWslDistributionByThreadId[threadId],
      ).toBeUndefined();
    } finally {
      await screen.unmount();
    }
  },
);

it("does not expose WSL on unsupported servers or SSH workspaces", async () => {
  mocks.distributions.mockResolvedValue({ supported: false, distributions: [] });
  const screen = await render(<ThreadTerminalDrawerToolbar {...props} />);
  try {
    await expect.poll(() => mocks.distributions.mock.calls.length).toBe(1);
    await expect
      .element(page.getByRole("button", { name: "New terminal target" }))
      .not.toBeInTheDocument();
    mocks.workspace = "ssh:host=box";
    mocks.distributions.mockClear();
    await screen.rerender(<ThreadTerminalDrawerToolbar {...props} />);
    await expect
      .element(page.getByRole("button", { name: "New terminal target" }))
      .not.toBeInTheDocument();
    expect(mocks.distributions).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});

it("keeps a stale selection and reports unavailable discovery without selecting another distro", async () => {
  useTerminalStateStore.getState().setTerminalWslDistribution(threadId, "Missing");
  const screen = await render(<ThreadTerminalDrawerToolbar {...props} />);
  try {
    await expect
      .element(page.getByRole("button", { name: "New terminal target" }))
      .toBeInTheDocument();
    mocks.distributions.mockRejectedValue(new Error("WSL is unavailable"));
    await page.getByRole("button", { name: "New terminal target" }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("WSL is unavailable");
    expect(useTerminalStateStore.getState().terminalWslDistributionByThreadId[threadId]).toBe(
      "Missing",
    );
    await expect.element(page.getByText(/Selected distro is unavailable/)).toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});
