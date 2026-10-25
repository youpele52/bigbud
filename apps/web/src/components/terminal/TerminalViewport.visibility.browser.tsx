import "../../index.css";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { TerminalSessionFixture } from "./TerminalViewport.session.fixture";
import { terminalRendererBudget } from "./TerminalRendererController.policy";

const mocks = vi.hoisted(() => ({
  open: vi.fn(async () => ({
    threadId: "terminal-fixture",
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
  write: vi.fn(async () => undefined),
  resize: vi.fn(async (_input: { cols: number; rows: number }) => undefined),
}));
vi.mock("../../rpc/nativeApi", () => ({ readNativeApi: () => ({ terminal: mocks }) }));
vi.mock("~/config/env", () => ({ isElectron: false }));

it("same-geometry CSS-hidden tab parks its GPU context, preserves xterm and resumes it on reveal", async () => {
  let terminal: Terminal | null = null;
  const addonDispose = vi.spyOn(WebglAddon.prototype, "dispose");
  const onTerminal = (value: Terminal | null) => {
    terminal = value;
  };
  const screen = await render(
    <TerminalSessionFixture
      fontSize={12}
      gpu="on"
      visible
      hiddenLayout="visibility"
      onTerminal={onTerminal}
    />,
  );
  try {
    await expect.poll(() => screen.container.textContent).toContain("readywebgl");
    const original = terminal!;
    const buffer = original.buffer.active;
    const dispose = vi.spyOn(original, "dispose");
    const loadAddon = vi.spyOn(original, "loadAddon");
    const mount = original.element!.parentElement!;
    const before = mount.getBoundingClientRect();
    expect(terminalRendererBudget.count).toBe(1);
    await screen.rerender(
      <TerminalSessionFixture
        fontSize={12}
        gpu="on"
        visible={false}
        hiddenLayout="visibility"
        onTerminal={onTerminal}
      />,
    );
    // The visible slot is released; the context itself is retained for a quick return.
    await expect.poll(() => terminalRendererBudget.count).toBe(0);
    expect(terminalRendererBudget.retainedCount).toBe(1);
    expect(addonDispose).not.toHaveBeenCalled();
    expect(original.options.cursorBlink).toBe(false);
    expect(getComputedStyle(mount).visibility).toBe("hidden");
    expect([mount.getBoundingClientRect().width, mount.getBoundingClientRect().height]).toEqual([
      before.width,
      before.height,
    ]);
    expect(terminal).toBe(original);
    expect(original.buffer.active).toBe(buffer);
    expect(dispose).not.toHaveBeenCalled();
    await screen.rerender(
      <TerminalSessionFixture
        fontSize={12}
        gpu="on"
        visible
        hiddenLayout="visibility"
        onTerminal={onTerminal}
      />,
    );
    await expect.poll(() => screen.container.textContent).toContain("readywebgl");
    await expect.poll(() => terminalRendererBudget.count).toBe(1);
    expect(terminalRendererBudget.retainedCount).toBe(0);
    expect(loadAddon).not.toHaveBeenCalled(); // Same context, no atlas rebuild.
    expect(original.options.cursorBlink).toBe(true);
    expect(original.buffer.active).toBe(buffer);
  } finally {
    await screen.unmount();
    expect(terminalRendererBudget.count).toBe(0);
    expect(terminalRendererBudget.retainedCount).toBe(0);
    expect(addonDispose).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  }
});

it("retained display-none drawer applies fonts in place without hidden reflow/PTY resize, then fits visible geometry", async () => {
  mocks.open.mockClear();
  mocks.resize.mockClear();
  let terminal: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  const onTerminal = (value: Terminal | null) => {
    terminal = value;
  };
  const onFitAddon = (value: FitAddon | null) => {
    fitAddon = value;
  };
  const screen = await render(
    <TerminalSessionFixture
      fontSize={12}
      visible
      hiddenLayout="none"
      onTerminal={onTerminal}
      onFitAddon={onFitAddon}
    />,
  );
  try {
    await expect.poll(() => screen.container.textContent).toContain("ready");
    const original = terminal!;
    const fit = fitAddon!;
    // Allow initial font/layout scheduling to settle before observing the hidden interval.
    await expect.poll(() => mocks.resize.mock.calls.length).toBeGreaterThan(0);
    await screen.rerender(
      <TerminalSessionFixture
        fontSize={12}
        visible={false}
        hiddenLayout="none"
        onTerminal={onTerminal}
        onFitAddon={onFitAddon}
      />,
    );
    const geometry = [original.cols, original.rows];
    const fitSpy = vi.spyOn(fit, "fit");
    const reflow = vi.spyOn(original, "resize");
    mocks.resize.mockClear();
    await screen.rerender(
      <TerminalSessionFixture
        fontSize={20}
        visible={false}
        hiddenLayout="none"
        onTerminal={onTerminal}
        onFitAddon={onFitAddon}
      />,
    );
    await expect.poll(() => original.options.fontSize).toBe(20);
    // Wait two actual frames, including any queued observer/layout work.
    await new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
    expect(fitSpy).not.toHaveBeenCalled();
    expect(reflow).not.toHaveBeenCalled();
    expect(mocks.resize).not.toHaveBeenCalled();
    expect([original.cols, original.rows]).toEqual(geometry);
    await screen.rerender(
      <TerminalSessionFixture
        fontSize={20}
        visible
        hiddenLayout="none"
        onTerminal={onTerminal}
        onFitAddon={onFitAddon}
      />,
    );
    await expect.poll(() => fitSpy.mock.calls.length).toBeGreaterThan(0);
    await expect
      .poll(() => mocks.resize.mock.calls.at(-1)?.[0])
      .toMatchObject({
        cols: original.cols,
        rows: original.rows,
      });
    expect({ cols: original.cols, rows: original.rows }).toEqual(fit.proposeDimensions());
    expect(original.cols).toBeLessThan(geometry[0]!);
    expect(original.rows).toBeLessThan(geometry[1]!);
    expect(terminal).toBe(original);
    expect(mocks.open).toHaveBeenCalledOnce();
  } finally {
    await screen.unmount();
    vi.restoreAllMocks();
  }
});
