import "../../index.css";
import { Terminal } from "@xterm/xterm";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import { ToastProvider, toastManager } from "../ui/toast";

const mocks = vi.hoisted(() => ({
  open: vi.fn(async () => ({
    threadId: "reliability",
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
  })),
  resize: vi.fn(async (_input: { cols: number; rows: number }) => undefined),
  write: vi.fn(async () => undefined),
  settings: {
    terminalFontFamily: "system-monospace",
    terminalFontSize: 12,
    terminalGpuAcceleration: "on",
  },
}));
vi.mock("../../rpc/nativeApi", () => ({ readNativeApi: () => ({ terminal: mocks }) }));
vi.mock("../../hooks/useSettings", () => ({ useSettings: () => mocks.settings }));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useParams: () => "reliability",
}));

it.each(["off", "on"])(
  "GPU %s: real viewport finishes replay, removes the real loading toast and follows window grow/shrink",
  async (gpu) => {
    vi.clearAllMocks();
    mocks.settings.terminalGpuAcceleration = gpu;
    await page.viewport(900, 600);
    const opened = vi.spyOn(Terminal.prototype, "open");
    const provider = await render(<ToastProvider />);
    const screen = await render(
      <div className="flex flex-col" style={{ position: "fixed", inset: 0 }}>
        <div className="min-h-0 flex-1 overflow-hidden">
          <ThreadTerminalDrawer
            threadId={ThreadId.makeUnsafe("reliability")}
            terminalBaseLabel="Chats"
            visible
            cwd="/synthetic"
            height={300}
            fillAvailableSpace
            terminalIds={["synthetic"]}
            activeTerminalId="synthetic"
            terminalGroups={[]}
            activeTerminalGroupId="group-synthetic"
            terminalLabelOverrides={{}}
            terminalProviderById={{}}
            onSplitTerminal={() => undefined}
            onNewTerminal={() => undefined}
            onActiveTerminalChange={() => undefined}
            onCloseTerminal={() => undefined}
            onHeightChange={() => undefined}
            onSetTerminalLabelOverride={() => undefined}
            onClearTerminalLabelOverride={() => undefined}
            onAddTerminalContext={() => undefined}
            focusRequestId={0}
            keybindings={[]}
          />
        </div>
      </div>,
    );
    try {
      await expect.poll(() => opened.mock.instances.length).toBe(1);
      const terminal = opened.mock.instances[0] as Terminal;
      await expect.poll(() => terminal.options.disableStdin).toBe(false);
      terminal.input("live-user", true);
      await expect.poll(() => mocks.write.mock.calls.length).toBe(1);
      await expect
        .poll(() => document.querySelector('[data-slot="toast-title"]')?.textContent ?? "")
        .toBe("");
      const buffer = terminal.buffer.active;
      expect(buffer.type).toBe("alternate");
      await expect
        .poll(() => mocks.resize.mock.calls.at(-1)?.[0])
        .toMatchObject({ cols: terminal.cols, rows: terminal.rows });
      const initial = { cols: terminal.cols, rows: terminal.rows };
      await page.viewport(1200, 800);
      await expect.poll(() => terminal.cols).toBeGreaterThan(initial.cols);
      await expect.poll(() => terminal.rows).toBeGreaterThan(initial.rows);
      await expect
        .poll(() => mocks.resize.mock.calls.at(-1)?.[0])
        .toMatchObject({ cols: terminal.cols, rows: terminal.rows });
      await page.viewport(700, 400);
      await expect.poll(() => terminal.cols).toBeLessThan(initial.cols);
      await expect.poll(() => terminal.rows).toBeLessThan(initial.rows);
      await expect
        .poll(() => mocks.resize.mock.calls.at(-1)?.[0])
        .toMatchObject({ cols: terminal.cols, rows: terminal.rows });
      expect(terminal.buffer.active).toBe(buffer);
      expect(buffer.getLine(0)?.translateToString(true)).toBe("TUI");
      expect(opened).toHaveBeenCalledOnce();
      expect(mocks.open).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
      toastManager.close();
      await provider.unmount();
      opened.mockRestore();
    }
  },
);
