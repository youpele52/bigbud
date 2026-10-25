import "../../index.css";
import { Terminal } from "@xterm/xterm";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { TerminalViewport } from "./TerminalViewport";
import { ToastProvider, toastManager } from "../ui/toast";

const mocks = vi.hoisted(() => ({
  open: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  resize: vi.fn(async (_input: { cols: number; rows: number }) => undefined),
  write: vi.fn(async () => undefined),
  settings: {
    terminalFontFamily: "system-monospace",
    terminalFontSize: 12,
    terminalGpuAcceleration: "off",
  },
}));
vi.mock("../../rpc/nativeApi", () => ({ readNativeApi: () => ({ terminal: mocks }) }));
vi.mock("../../hooks/useSettings", () => ({ useSettings: () => mocks.settings }));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useParams: () => "opening-resize",
}));

it.each([
  { width: 1200, height: 800 },
  { width: 700, height: 400 },
])(
  "reconciles the PTY size after a pending open and resize to $width × $height",
  async ({ width, height }) => {
    vi.clearAllMocks();
    await page.viewport(900, 600);
    let finishOpen!: () => void;
    let ptySize: { cols: number; rows: number } | null = null;
    mocks.open.mockImplementation(
      (input) =>
        new Promise((resolve) => {
          finishOpen = () => {
            ptySize = input as { cols: number; rows: number };
            resolve({
              threadId: "opening-resize",
              terminalId: "synthetic",
              dropPathMode: "posix",
              cwd: "/synthetic",
              worktreePath: null,
              status: "running",
              pid: 1,
              history: "\x1b[?1049hTUI",
              exitCode: null,
              exitSignal: null,
              updatedAt: "2026-10-10T00:00:00.000Z",
            });
          };
        }),
    );
    mocks.resize.mockImplementation(async (input) => {
      if (!ptySize) throw new Error("Terminal is not running yet");
      ptySize = input;
    });
    const opened = vi.spyOn(Terminal.prototype, "open");
    const provider = await render(<ToastProvider />);
    const screen = await render(
      <div style={{ position: "fixed", inset: 0 }}>
        <TerminalViewport
          threadId={ThreadId.makeUnsafe("opening-resize")}
          terminalId="synthetic"
          terminalLabel="Chats"
          visible
          cwd="/synthetic"
          onSessionExited={() => undefined}
          onAddTerminalContext={() => undefined}
          autoFocus={false}
          focusRequestId={0}
          resizeEpoch={0}
          drawerHeight={300}
          keybindings={[]}
        />
      </div>,
    );
    try {
      await expect.poll(() => mocks.open.mock.calls.length).toBe(1);
      await expect.element(provider.getByText("Chats: resolving terminal folder")).toBeVisible();
      const terminal = opened.mock.instances[0] as Terminal;
      const initialCols = terminal.cols;
      await page.viewport(width, height);
      await expect.poll(() => terminal.cols).not.toBe(initialCols);
      expect(mocks.resize).not.toHaveBeenCalled(); // No redraw/query storm while history is gated.
      finishOpen();
      await expect.poll(() => terminal.options.disableStdin).toBe(false);
      await expect
        .element(provider.getByText("Chats: resolving terminal folder"))
        .not.toBeInTheDocument();
      await expect.poll(() => ptySize).toMatchObject({ cols: terminal.cols, rows: terminal.rows });
      expect(mocks.open).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
      toastManager.close();
      await provider.unmount();
      opened.mockRestore();
    }
  },
);
