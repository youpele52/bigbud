import "../../index.css";
import type { Terminal } from "@xterm/xterm";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { TerminalSessionFixture } from "./TerminalViewport.session.fixture";
import { forgetTerminalLaunch } from "../../lib/terminalLaunchBinding";
import {
  readTerminalLifecycleDiagnostics,
  setTerminalLifecycleDiagnosticsEnabled,
} from "./TerminalLifecycleDiagnostics";

const mocks = vi.hoisted(() => {
  const baseline = {
    threadId: "terminal-fixture",
    terminalId: "synthetic",
    dropPathMode: "posix",
    cwd: "/synthetic",
    worktreePath: null,
    status: "running",
    pid: 42,
    runtimeGeneration: "same-process",
    history: "\x1b[?1049hTUI",
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-11-01T00:00:00.000Z",
    historyTruncated: false,
  };
  return {
    baseline,
    open: vi.fn(async () => baseline),
    resize: vi.fn(async (_geometry: { cols: number; rows: number }) => undefined),
    write: vi.fn(async () => undefined),
  };
});
vi.mock("../../rpc/nativeApi", () => ({ readNativeApi: () => ({ terminal: mocks }) }));

afterEach(() => {
  setTerminalLifecycleDiagnosticsEnabled(false);
  forgetTerminalLaunch("terminal-fixture", "synthetic");
});

it("distinguishes four visibility switches from a fresh emulator reattached after exhausted history", async () => {
  setTerminalLifecycleDiagnosticsEnabled(true);
  let terminal: Terminal | null = null;
  const onTerminal = (value: Terminal | null) => {
    terminal = value;
  };
  const screen = await render(<TerminalSessionFixture fontSize={12} onTerminal={onTerminal} />);
  try {
    await expect.poll(() => terminal?.options.disableStdin).toBe(false);
    const original = terminal!;
    for (let i = 0; i < 4; i++) {
      await screen.rerender(
        <TerminalSessionFixture
          fontSize={12}
          visible={false}
          hiddenLayout="visibility"
          onTerminal={onTerminal}
        />,
      );
      await screen.rerender(
        <TerminalSessionFixture fontSize={12} visible onTerminal={onTerminal} />,
      );
      expect(terminal).toBe(original);
    }
    expect(mocks.open).toHaveBeenCalledOnce();
    expect(
      readTerminalLifecycleDiagnostics().filter((trace) => trace.event.type === "mounted"),
    ).toHaveLength(1);
    expect(
      readTerminalLifecycleDiagnostics().filter((trace) => trace.event.type === "disposed"),
    ).toHaveLength(0);
    original.input("still-working", true);
    await expect.poll(() => mocks.write.mock.calls.length).toBe(1);
  } finally {
    await screen.unmount();
  }
  mocks.open.mockResolvedValue({
    ...mocks.baseline,
    history: "",
    historyTruncated: true,
    updatedAt: "2026-11-01T00:00:01.000Z",
  });
  const fresh = await render(<TerminalSessionFixture fontSize={12} onTerminal={onTerminal} />);
  try {
    await expect
      .poll(() =>
        readTerminalLifecycleDiagnostics().some(
          (trace) => trace.event.type === "hydration" && trace.event.state === "reattached",
        ),
      )
      .toBe(true);
    expect(terminal!.options.disableStdin).toBe(false);
    // The surviving program is asked to repaint: one row smaller, then the view's own size.
    const rows = terminal!.rows;
    await expect
      .poll(() => mocks.resize.mock.calls.map(([geometry]) => geometry.rows))
      .toEqual(expect.arrayContaining([rows - 1, rows]));
    const sizes = mocks.resize.mock.calls.map(([geometry]) => geometry.rows);
    expect(sizes.lastIndexOf(rows)).toBeGreaterThan(sizes.indexOf(rows - 1));
    const traces = readTerminalLifecycleDiagnostics();
    const mounts = traces.filter((trace) => trace.event.type === "mounted");
    expect(mounts).toHaveLength(2);
    expect(mounts[0]!.viewId).not.toBe(mounts[1]!.viewId);
    const snapshots = traces.filter((trace) => trace.event.type === "snapshot");
    expect(snapshots.map((trace) => trace.event)).toEqual([
      expect.objectContaining({ pid: 42, generation: "same-process", truncated: false }),
      expect.objectContaining({ pid: 42, generation: "same-process", truncated: true }),
    ]);
    expect(mocks.write).toHaveBeenCalledOnce();
    terminal!.input("after-reattach", true);
    await expect.poll(() => mocks.write.mock.calls.length).toBe(2);
  } finally {
    await fresh.unmount();
  }
});
