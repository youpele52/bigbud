import "../../index.css";
import { Terminal } from "@xterm/xterm";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { TerminalViewport } from "./TerminalViewport";
import { publishTerminalOutput } from "./TerminalOutputStream";
import { ToastProvider, toastManager } from "../ui/toast";

const mocks = vi.hoisted(() => {
  const baseline = {
    threadId: "recovery",
    terminalId: "synthetic",
    dropPathMode: "posix" as const,
    cwd: "/synthetic",
    worktreePath: null,
    status: "running" as const,
    pid: 1,
    history: "original",
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-10-11T00:00:00.000Z",
  };
  return {
    baseline,
    open: vi.fn(async () => baseline),
    confirm: vi.fn(async (_message: string) => true),
    restart: vi.fn(async (_input: unknown) => ({
      ...baseline,
      pid: 2,
      history: "fresh",
      updatedAt: "2026-10-11T00:00:03.000Z",
    })),
    snapshot: vi.fn(async () => ({
      ...baseline,
      history: "recovered",
      updatedAt: "2026-10-11T00:00:02.000Z",
    })),
    resize: vi.fn(async () => undefined),
    write: vi.fn(async () => undefined),
    settings: {
      terminalFontFamily: "system-monospace",
      terminalFontSize: 12,
      terminalGpuAcceleration: "off",
    },
  };
});
vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => ({ terminal: mocks, dialogs: { confirm: mocks.confirm } }),
}));
vi.mock("../../hooks/useSettings", () => ({ useSettings: () => mocks.settings }));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useParams: () => "recovery",
}));

it.each([false, true])(
  "started-before-open (large history=%s) and explicit recovery preserve the emulator and never restart",
  async (large) => {
    vi.clearAllMocks();
    const snapshot = {
      ...mocks.baseline,
      history: large ? "\x1b[H\x1b[32moriginal\x1b[0m".repeat(40_000) : "original",
    };
    mocks.open.mockImplementation(async () => {
      publishTerminalOutput({
        type: "started",
        threadId: "recovery",
        terminalId: "synthetic",
        createdAt: snapshot.updatedAt,
        snapshot,
      });
      return snapshot;
    });
    const opened = vi.spyOn(Terminal.prototype, "open");
    const provider = await render(<ToastProvider />);
    const screen = await render(
      <div style={{ width: 800, height: 400 }}>
        <TerminalViewport
          threadId={ThreadId.makeUnsafe("recovery")}
          terminalId="synthetic"
          terminalLabel="Chats"
          visible
          cwd="/synthetic"
          onSessionExited={() => undefined}
          onAddTerminalContext={() => undefined}
          autoFocus={false}
          focusRequestId={0}
          resizeEpoch={0}
          drawerHeight={400}
          keybindings={[]}
        />
      </div>,
    );
    try {
      await expect.poll(() => opened.mock.instances.length).toBe(1);
      const terminal = opened.mock.instances[0] as Terminal;
      await expect.poll(() => terminal.options.disableStdin, { timeout: 10000 }).toBe(false);
      publishTerminalOutput({
        type: "output",
        threadId: "recovery",
        terminalId: "synthetic",
        data: "x".repeat(400_000),
        createdAt: "2026-10-11T00:00:01.000Z",
      });
      await expect.element(provider.getByText("Chats: terminal input paused")).toBeVisible();
      expect(terminal.options.disableStdin).toBe(true);
      mocks.snapshot.mockRejectedValueOnce(new Error("Unknown RPC terminal.snapshot"));
      await provider.getByRole("button", { name: "Reload legacy view" }).click();
      await expect.element(provider.getByText(/Unknown RPC terminal.snapshot/)).toBeVisible();
      expect(mocks.open).toHaveBeenCalledOnce();
      expect(terminal.options.disableStdin).toBe(true);
      await provider.getByRole("button", { name: "Reload legacy view" }).click();
      await expect.poll(() => terminal.options.disableStdin, { timeout: 10000 }).toBe(false);
      await expect
        .poll(() => terminal.buffer.active.getLine(0)?.translateToString(true))
        .toBe("recovered");
      expect(mocks.open).toHaveBeenCalledOnce();
      expect(mocks.snapshot).toHaveBeenCalledTimes(2);
      expect(mocks.snapshot).toHaveBeenLastCalledWith({
        threadId: "recovery",
        terminalId: "synthetic",
      });
      expect(opened).toHaveBeenCalledOnce();
      expect(mocks.write).not.toHaveBeenCalled();
      await expect
        .element(provider.getByText("Chats: terminal input paused"))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
      toastManager.close();
      await provider.unmount();
      opened.mockRestore();
    }
  },
);

it.each(["historyTruncated", "historyUnavailable"] as const)(
  "%s offers confirmed restart, not futile snapshot reload, and installs a working fresh delivery",
  async (reason) => {
    vi.clearAllMocks();
    mocks.open.mockResolvedValue({ ...mocks.baseline, history: "", [reason]: true });
    const fresh = {
      ...mocks.baseline,
      pid: 2,
      history: "fresh Pi",
      updatedAt: "2026-10-11T00:00:03.000Z",
    };
    mocks.restart.mockImplementation(async () => {
      publishTerminalOutput({
        type: "restarted",
        threadId: "recovery",
        terminalId: "synthetic",
        createdAt: fresh.updatedAt,
        snapshot: fresh,
      });
      publishTerminalOutput({
        type: "output",
        threadId: "recovery",
        terminalId: "synthetic",
        createdAt: "2026-10-11T00:00:04.000Z",
        data: " live",
      });
      return fresh;
    });
    const opened = vi.spyOn(Terminal.prototype, "open");
    const onExit = vi.fn();
    const provider = await render(<ToastProvider />);
    const screen = await render(
      <div style={{ width: 800, height: 400 }}>
        <TerminalViewport
          threadId={ThreadId.makeUnsafe("recovery")}
          terminalId="synthetic"
          terminalLabel="Chats"
          visible
          cwd="/synthetic"
          onSessionExited={onExit}
          onAddTerminalContext={() => undefined}
          autoFocus={false}
          focusRequestId={0}
          resizeEpoch={0}
          drawerHeight={400}
          keybindings={[]}
        />
      </div>,
    );
    try {
      await expect
        .element(provider.getByRole("button", { name: "Restart terminal", exact: true }))
        .toBeVisible();
      await expect
        .element(provider.getByRole("button", { name: "Reload legacy view" }))
        .not.toBeInTheDocument();
      const terminal = opened.mock.instances[0] as Terminal;
      expect(terminal.options.disableStdin).toBe(true);
      expect(mocks.restart).not.toHaveBeenCalled();
      mocks.confirm.mockResolvedValueOnce(false);
      await provider.getByRole("button", { name: "Restart terminal", exact: true }).click();
      await expect.poll(() => mocks.confirm.mock.calls.length).toBe(1);
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(terminal.options.disableStdin).toBe(true);
      mocks.restart.mockRejectedValueOnce(new Error("Restart transport failed"));
      await provider.getByRole("button", { name: "Restart terminal", exact: true }).click();
      await expect.element(provider.getByText("Restart transport failed")).toBeVisible();
      expect(terminal.options.disableStdin).toBe(true);
      await provider.getByRole("button", { name: "Restart terminal", exact: true }).click();
      await expect.poll(() => terminal.options.disableStdin).toBe(false);
      await expect
        .poll(() => terminal.buffer.active.getLine(0)?.translateToString(true))
        .toBe("fresh Pi live");
      terminal.input("working", true);
      await expect.poll(() => mocks.write.mock.calls.length).toBe(1);
      expect(mocks.confirm).toHaveBeenCalledWith(
        expect.stringContaining("terminates its running shell and programs"),
      );
      expect(mocks.restart).toHaveBeenLastCalledWith(
        expect.objectContaining({
          threadId: "recovery",
          terminalId: "synthetic",
          cwd: "/synthetic",
        }),
      );
      expect(fresh.pid).not.toBe(mocks.baseline.pid);
      expect(mocks.snapshot).not.toHaveBeenCalled();
      expect(mocks.open).toHaveBeenCalledOnce();
      expect(opened).toHaveBeenCalledOnce();
      expect(onExit).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      toastManager.close();
      await provider.unmount();
      opened.mockRestore();
    }
  },
);
