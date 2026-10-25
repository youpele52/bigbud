import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRenderRepair, type TerminalRenderRepairOptions } from "./TerminalRenderRepair";

function fakeTerminal() {
  const listeners: Array<(event: { start: number; end: number } | undefined) => void> = [];
  const active = { type: "normal", cursorY: 3, baseY: 0, viewportY: 0 };
  const terminal = {
    rows: 24,
    buffer: { active },
    refresh: vi.fn(),
    _core: {
      refresh: vi.fn(),
      _inputHandler: {
        onRequestRefreshRows: (listener: (typeof listeners)[number]) => {
          listeners.push(listener);
          return { dispose: () => listeners.splice(listeners.indexOf(listener), 1) };
        },
      },
    },
  };
  const parse = (start: number, end: number) =>
    listeners.forEach((listener) => listener({ start, end }));
  return { terminal, active, parse, listeners };
}

describe("TerminalRenderRepair", () => {
  let frames: FrameRequestCallback[];
  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  function repairFor(options: Partial<TerminalRenderRepairOptions> = {}) {
    const fake = fakeTerminal();
    const repair = new TerminalRenderRepair(fake.terminal as never, {
      isWebgl: () => false,
      lastInputAt: () => -Infinity,
      windowsClient: false,
      nativeWindowsConpty: false,
      now: () => 0,
      ...options,
    });
    return { ...fake, repair };
  }

  it("leaves plain appended output to xterm's own frame", () => {
    const { repair } = repairFor();
    expect(repair.prepare("hello\r\nworld\r\n")).toBeUndefined();
  });

  it("synchronously repaints exactly the parsed rows of an in-place rewrite on the DOM renderer", () => {
    const { repair, terminal, parse, active } = repairFor();
    const complete = repair.prepare("\r\x1b[2Kprogress 42%");
    expect(complete).toBeTypeOf("function");
    parse(5, 6);
    active.cursorY = 6;
    complete!();
    expect(terminal._core.refresh).toHaveBeenCalledWith(3, 6, true);
    expect(terminal.refresh).not.toHaveBeenCalled();
    expect(frames).toHaveLength(0);
  });

  it("merges the repair into xterm's queued frame under WebGL", () => {
    const { repair, terminal, parse } = repairFor({ isWebgl: () => true });
    const complete = repair.prepare("\x1b[42m status \x1b[0m");
    parse(0, 0);
    complete!();
    expect(terminal.refresh).toHaveBeenCalledWith(0, 3);
    expect(terminal._core.refresh).not.toHaveBeenCalled();
  });

  it("repaints the whole viewport and one follow-up frame when the write scrolled", () => {
    const { repair, terminal, parse, active } = repairFor();
    const complete = repair.prepare("\r\x1b[Kline\n");
    parse(20, 23);
    active.baseY = 1;
    active.viewportY = 1;
    complete!();
    expect(terminal._core.refresh).toHaveBeenCalledWith(0, 23, true);
    expect(frames).toHaveLength(1);
    frames[0]!(0);
    expect(terminal._core.refresh).toHaveBeenCalledTimes(2);
  });

  it("carries a trailing carriage return and a split escape across chunks", () => {
    const { repair } = repairFor();
    // A chunk ending in CR is ambiguous until the next one shows whether "\n" follows.
    expect(repair.prepare("spinner\r")).toBeUndefined();
    expect(repair.prepare("next")).toBeTypeOf("function");
    expect(repair.prepare("ok\r")).toBeUndefined();
    expect(repair.prepare("\nline")).toBeUndefined();
    expect(repair.prepare("text \x1b[4")).toBeUndefined();
    expect(repair.prepare("4mbg")).toBeTypeOf("function");
  });

  it("repaints wide East Asian output on every platform", () => {
    expect(repairFor().repair.prepare("漢字")).toBeTypeOf("function");
    expect(repairFor({ nativeWindowsConpty: true }).repair.prepare("한국어")).toBeTypeOf(
      "function",
    );
  });

  it("stops repairing and releases the private listener on dispose", () => {
    const { repair, terminal, listeners } = repairFor();
    const complete = repair.prepare("\r\x1b[2Kx");
    expect(listeners).toHaveLength(1);
    repair.dispose();
    complete!();
    expect(listeners).toHaveLength(0);
    expect(terminal._core.refresh).not.toHaveBeenCalled();
    expect(repair.prepare("\r\x1b[2Ky")).toBeUndefined();
  });

  it("survives a terminal without private internals", () => {
    const { repair, terminal } = repairFor();
    delete (terminal as { _core?: unknown })._core;
    const complete = repair.prepare("\r\x1b[2Kx");
    complete!();
    expect(terminal.refresh).toHaveBeenCalledWith(0, 23);
  });
});
