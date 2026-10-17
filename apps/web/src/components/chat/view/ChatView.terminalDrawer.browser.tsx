import "../../../index.css";
import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { TerminalDrawerSwitchFixture } from "./ChatView.terminalDrawer.fixture";
import { terminalRendererBudget } from "../../terminal/TerminalRendererController.policy";
import { publishTerminalOutput } from "../../terminal/TerminalOutputStream";
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
    history: "line diagnostic 1234567890123456789012345678901234567890\r\n".repeat(150),
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-10-10T00:00:00.000Z",
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

it("warm thread/layout switches retain measurable emulators, release hidden GPU and never replay entrance", async () => {
  resetTerminalStore();
  vi.clearAllMocks();
  for (const id of ["a", "b"])
    useTerminalStateStore.getState().setTerminalOpen(ThreadId.makeUnsafe(id), true);
  const opened = vi.spyOn(Terminal.prototype, "open");
  const disposed = vi.spyOn(Terminal.prototype, "dispose");
  const addonDisposed = vi.spyOn(WebglAddon.prototype, "dispose");
  const screen = await render(<TerminalDrawerSwitchFixture />);
  let widthSpy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await expect.poll(() => opened.mock.instances.length).toBe(2);
    const terminals = opened.mock.instances as Terminal[];
    await expect.poll(() => terminals[0]!.options.disableStdin, { timeout: 15000 }).toBe(false);
    // Hidden sessions deliberately defer their first RPC until their viewport is usable.
    await screen.rerender(<TerminalDrawerSwitchFixture active="b" />);
    await expect
      .poll(() => terminals.every((terminal) => !terminal.options.disableStdin), { timeout: 15000 })
      .toBe(true);
    await expect.poll(() => terminalRendererBudget.count).toBe(1);
    for (const [input] of mocks.open.mock.calls) {
      publishTerminalOutput({
        type: "output",
        ...input,
        data: "\x1b[H\x1b[2Jold OpenCode",
        createdAt: "2026-10-10T00:00:01.000Z",
      });
      publishTerminalOutput({
        type: "output",
        ...input,
        data: "\x1b[H\x1b[2Jcurrent Pi",
        createdAt: "2026-10-10T00:00:02.000Z",
      });
    }
    const currentScreen = (terminal: Terminal) =>
      terminal.buffer.active.getLine(terminal.buffer.active.baseY)?.translateToString(true);
    await expect.poll(() => terminals.map(currentScreen)).toEqual(["current Pi", "current Pi"]);
    const writes = terminals.map((terminal) => vi.spyOn(terminal, "write"));
    const buffers = terminals.map((terminal) => terminal.buffer.active);
    const readWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!.get!;
    let measurements = 0;
    let zeroMeasurements = 0;
    widthSpy = vi
      .spyOn(HTMLElement.prototype, "offsetWidth", "get")
      .mockImplementation(function (this: HTMLElement) {
        const width = readWidth.call(this) as number;
        if (this.parentElement?.classList.contains("xterm-width-cache-measure-container")) {
          measurements++;
          if (width === 0) zeroMeasurements++;
        }
        return width;
      });
    for (const active of ["a", "b", "a", "b", "a"]) {
      await screen.rerender(<TerminalDrawerSwitchFixture active={active} />);
      await expect.poll(() => terminalRendererBudget.count).toBe(1);
      const shown = screen.container.querySelector<HTMLElement>(
        '[data-terminal-presentation="fill"]',
      )!;
      const hidden = screen.container.querySelector<HTMLElement>(
        '[data-terminal-presentation="hidden"]',
      )!;
      expect(getComputedStyle(shown).opacity).toBe("1");
      expect(getComputedStyle(shown).transform).toBe("none");
      expect(getComputedStyle(hidden).visibility).toBe("hidden");
      expect(getComputedStyle(hidden).position).toBe("absolute");
      expect(hidden.getBoundingClientRect().width).toBeGreaterThan(0);
      expect(hidden.getBoundingClientRect().height).toBeGreaterThan(0);
      expect(hidden.inert).toBe(true);
      expect(hidden.getAttribute("aria-hidden")).toBe("true");
      expect(hidden.contains(document.activeElement)).toBe(false);
      // A queued exit transition from an earlier render must not unmount a retained open drawer.
      hidden.dispatchEvent(
        new TransitionEvent("transitionend", { bubbles: true, propertyName: "opacity" }),
      );
      await frames();
      expect(hidden.querySelector(".xterm")).not.toBeNull();
    }
    expect(measurements).toBeGreaterThan(0); // Real WebGL -> DOM handoff ran the width-cache path.
    expect(zeroMeasurements).toBe(0);
    expect(addonDisposed.mock.calls.length).toBeGreaterThanOrEqual(4);
    await screen.rerender(<TerminalDrawerSwitchFixture presentation="hidden" />);
    await expect.poll(() => terminalRendererBudget.count).toBe(0);
    await screen.rerender(<TerminalDrawerSwitchFixture />);
    await expect.poll(() => terminalRendererBudget.count).toBe(1);
    expect(opened).toHaveBeenCalledTimes(2);
    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(disposed).not.toHaveBeenCalled();
    expect(terminals.map(currentScreen)).toEqual(["current Pi", "current Pi"]);
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(terminals.map((terminal) => terminal.buffer.active)).toEqual(buffers);
    expect(terminals.every((terminal) => terminal.buffer.active.length > terminal.rows)).toBe(true);

    // An intentional logical close still animates and tears down only the closed drawer.
    useTerminalStateStore.getState().setTerminalOpen(ThreadId.makeUnsafe("a"), false);
    await expect
      .poll(
        () =>
          screen.container.querySelector<HTMLElement>('[data-terminal-presentation="fill"]')?.style
            .maxHeight,
      )
      .toBe("");
    const closing = screen.container.querySelector<HTMLElement>(
      '[data-terminal-presentation="fill"]',
    )!;
    await expect.poll(() => closing.classList.contains("opacity-0")).toBe(true);
    closing.dispatchEvent(
      new TransitionEvent("transitionend", { bubbles: true, propertyName: "opacity" }),
    );
    await expect.poll(() => disposed.mock.calls.length).toBe(1);
    expect(terminalRendererBudget.count).toBe(0);
  } finally {
    widthSpy?.mockRestore();
    await screen.unmount();
    vi.restoreAllMocks();
    resetTerminalStore();
  }
});
