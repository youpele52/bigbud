import "../../../index.css";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { Terminal } from "@xterm/xterm";
import { useCallback, useState } from "react";
import { expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ChatLayoutMenu } from "../common/ChatHeader.layoutMenu";
import ThreadTerminalDrawer from "../../terminal/ThreadTerminalDrawer";
import { publishTerminalOutput } from "../../terminal/TerminalOutputStream";
import { ToastProvider, toastManager } from "../../ui/toast";
import { useTerminalLayout } from "./chat-view/terminalLayout.hooks";

const THREAD_ID = ThreadId.makeUnsafe("layout-session");
const mocks = vi.hoisted(() => ({
  open: vi.fn(async () => ({
    threadId: "layout-session",
    terminalId: "synthetic",
    dropPathMode: "posix",
    cwd: "/synthetic",
    worktreePath: null,
    status: "running",
    pid: 1,
    history: "original",
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-10-11T00:00:00.000Z",
  })),
  resize: vi.fn(async () => undefined),
  write: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  settings: {
    terminalFontFamily: "system-monospace",
    terminalFontSize: 12,
    terminalGpuAcceleration: "off",
  },
}));
vi.mock("../../../rpc/nativeApi", () => ({ readNativeApi: () => ({ terminal: mocks }) }));
vi.mock("../../../hooks/useSettings", () => ({ useSettings: () => mocks.settings }));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useParams: () => "layout-session",
}));

function TerminalSessionLayoutHarness({
  mode = "drawer",
  terminalIds = ["synthetic"],
  onToggleExpanded,
}: {
  mode?: "drawer" | "panel";
  terminalIds?: string[];
  onToggleExpanded?: () => void;
}) {
  const [terminalOpen, setTerminalOpenState] = useState(false);
  const [mounted, setMounted] = useState(false);
  const setTerminalOpen = useCallback((open: boolean) => {
    setTerminalOpenState(open);
    if (open) setMounted(true);
  }, []);
  const toggleTerminalVisibility = useCallback(() => setTerminalOpenState((open) => !open), []);
  const layout = useTerminalLayout({
    activeThreadId: THREAD_ID,
    terminalOpen,
    setTerminalOpen,
    toggleTerminalVisibility,
  });
  const terminalVisible = terminalOpen && layout.terminalPresentation !== "hidden";

  return (
    <div className="fixed inset-0 flex flex-col">
      <header>
        <ChatLayoutMenu mode={layout.mode} onSelectLayout={layout.selectLayout} />
      </header>
      <div
        className="min-h-0 flex-1"
        hidden={!layout.chatVisible}
        inert={!layout.chatVisible || undefined}
      >
        Chat
      </div>
      {mounted && (
        <div
          className={
            mode === "panel"
              ? "h-80 shrink-0"
              : layout.terminalPresentation === "fill"
                ? "min-h-0 flex-1"
                : "shrink-0"
          }
          data-terminal-layout={layout.terminalPresentation}
          hidden={!terminalVisible}
          inert={!terminalVisible || undefined}
        >
          <ThreadTerminalDrawer
            mode={mode}
            threadId={THREAD_ID}
            cwd="/synthetic"
            visible={terminalVisible}
            height={333}
            fillAvailableSpace={layout.terminalPresentation === "fill"}
            onToggleExpanded={onToggleExpanded ?? layout.toggleExpanded}
            terminalIds={terminalIds}
            activeTerminalId="synthetic"
            terminalGroups={[]}
            activeTerminalGroupId="group-synthetic"
            terminalBaseLabel="Chats"
            terminalLabelOverrides={{}}
            terminalProviderById={{}}
            focusRequestId={0}
            keybindings={[]}
            onSplitTerminal={() => undefined}
            onNewTerminal={() => undefined}
            onActiveTerminalChange={() => undefined}
            onCloseTerminal={mocks.close}
            onHeightChange={() => undefined}
            onAddTerminalContext={() => undefined}
            onSetTerminalLabelOverride={() => undefined}
            onClearTerminalLabelOverride={() => undefined}
          />
        </div>
      )}
    </div>
  );
}

async function selectLayout(label: string) {
  await page.getByRole("button", { name: "Chat layout", exact: true }).click();
  await page.getByRole("menuitemradio", { name: label, exact: true }).click();
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
}

it("keeps the real emulator, process, live hidden output and split size through explicit layouts", async () => {
  vi.clearAllMocks();
  await page.viewport(900, 600);
  const opened = vi.spyOn(Terminal.prototype, "open");
  const disposed = vi.spyOn(Terminal.prototype, "dispose");
  const provider = await render(<ToastProvider />);
  const screen = await render(<TerminalSessionLayoutHarness />);
  try {
    await selectLayout("Terminal only");
    await expect.poll(() => opened.mock.instances.length).toBe(1);
    const terminal = opened.mock.instances[0] as Terminal;
    await expect.poll(() => terminal.options.disableStdin).toBe(false);
    await expect.poll(() => mocks.resize.mock.calls.length).toBeGreaterThan(0);
    const buffer = terminal.buffer.active;
    const expandedRows = terminal.rows;
    await page.getByRole("button", { name: "Restore split view", exact: true }).click();
    await expect.poll(() => terminal.rows).toBeLessThan(expandedRows);
    expect(document.querySelector<HTMLElement>(".thread-terminal-drawer")!.style.height).toBe(
      "333px",
    );
    await selectLayout("Chat only");
    expect(document.querySelector<HTMLElement>("[data-terminal-layout]")!.hidden).toBe(true);
    publishTerminalOutput({
      type: "output",
      threadId: "layout-session",
      terminalId: "synthetic",
      data: "-hidden-output",
      createdAt: "2026-10-11T00:00:01.000Z",
    });
    await expect
      .poll(() => buffer.getLine(0)?.translateToString(true))
      .toBe("original-hidden-output");
    await selectLayout("Chat + terminal");
    terminal.input("still-live", true);
    await expect.poll(() => mocks.write.mock.calls.length).toBe(1);
    await page.getByRole("button", { name: "Expand terminal", exact: true }).click();
    await expect.poll(() => terminal.rows).toBe(expandedRows);
    expect(terminal.buffer.active).toBe(buffer);
    expect(opened).toHaveBeenCalledOnce();
    expect(mocks.open).toHaveBeenCalledOnce();
    expect(disposed).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
    toastManager.close();
    await provider.unmount();
    opened.mockRestore();
    disposed.mockRestore();
  }
});

it.each([
  { variant: "floating", terminalIds: ["synthetic"] },
  { variant: "sidebar", terminalIds: ["synthetic", "synthetic-2"] },
])(
  "keeps the real right-panel $variant toolbar uniform without exposing expansion",
  async ({ terminalIds }) => {
    vi.clearAllMocks();
    await page.viewport(900, 600);
    const onExpand = vi.fn();
    const provider = await render(<ToastProvider />);
    const screen = await render(
      <TerminalSessionLayoutHarness
        mode="panel"
        terminalIds={terminalIds}
        onToggleExpanded={onExpand}
      />,
    );
    try {
      await selectLayout("Chat + terminal");
      const drawer = document.querySelector<HTMLElement>(".thread-terminal-drawer")!;
      const buttons = Array.from(
        drawer.querySelectorAll<HTMLButtonElement>("button.transition-colors"),
      );
      expect(buttons.map((button) => button.ariaLabel)).toEqual([
        "New Terminal",
        "Split Terminal",
        "Rename Terminal",
        "Close Terminal",
      ]);
      const toolbar = buttons[0]!.parentElement!;
      const dividers = toolbar.querySelectorAll("div.w-px");
      expect(dividers).toHaveLength(2);
      expect(dividers[0]!.previousElementSibling).toBe(buttons[0]);
      expect(dividers[0]!.nextElementSibling).toBe(buttons[1]);
      expect(dividers[1]!.previousElementSibling).toBe(buttons[2]);
      expect(dividers[1]!.nextElementSibling).toBe(buttons[3]);
      const colors = buttons.map((button) => getComputedStyle(button).color);
      for (const [index, button] of buttons.entries()) {
        await page.getByRole("button", { name: button.ariaLabel!, exact: true }).hover();
        await vi.waitFor(() => {
          expect(getComputedStyle(button).color).not.toBe(colors[index]);
          for (const [neighborIndex, neighbor] of buttons.entries()) {
            if (neighbor !== button)
              expect(getComputedStyle(neighbor).color).toBe(colors[neighborIndex]);
          }
        });
      }
      await page.getByRole("button", { name: "Chat layout", exact: true }).hover();
      await userEvent.keyboard("{Tab}");
      for (const [index, button] of buttons.entries()) {
        button.focus();
        expect(button.matches(":focus-visible")).toBe(true);
        await vi.waitFor(() => {
          expect(getComputedStyle(button).color).not.toBe(colors[index]);
          for (const [neighborIndex, neighbor] of buttons.entries()) {
            if (neighbor !== button)
              expect(getComputedStyle(neighbor).color).toBe(colors[neighborIndex]);
          }
        });
      }
      await selectLayout("Terminal only");
      expect(drawer.querySelector('[aria-label="Expand terminal"]')).toBeNull();
      expect(drawer.querySelector('[aria-label="Restore split view"]')).toBeNull();
      expect(onExpand).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      toastManager.close();
      await provider.unmount();
    }
  },
);
