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
vi.mock("../../rpc/nativeApi", () => ({ readNativeApi: () => ({ terminal: mocks }) }));
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
