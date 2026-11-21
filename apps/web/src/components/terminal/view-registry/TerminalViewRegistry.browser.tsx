import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalViewportProps } from "../TerminalViewport.types";
import { moveTerminalViewHost } from "./TerminalViewRegistry.dom";
import { TerminalViewRegistry, type TerminalViewRegistryClock } from "./TerminalViewRegistry";
import { TERMINAL_VIEW_PARK_DELAY_MS } from "./TerminalViewRegistry.policy";

const write = (terminal: Terminal, data: string) =>
  new Promise<void>((resolve) => terminal.write(data, resolve));
const box = () => {
  const element = document.createElement("div");
  element.style.cssText = "width:600px;height:300px";
  document.body.append(element);
  return element;
};
afterEach(() => {
  document.body.innerHTML = "";
});

describe("reparenting spike (kept as a regression test)", () => {
  it.each([true, false])(
    "moveBefore=%s keeps the buffer, the WebGL context and focus",
    async (native) => {
      const [from, to] = [box(), box()];
      const host = document.createElement("div");
      host.style.cssText = "width:100%;height:100%";
      from.append(host);
      const terminal = new Terminal({ cols: 40, rows: 8, allowProposedApi: true });
      terminal.open(host);
      const addon = new WebglAddon();
      const lost = vi.fn();
      addon.onContextLoss(lost);
      terminal.loadAddon(addon);
      await write(terminal, "hello\r\nworld\x1b[?1049hTUI");
      const canvas = Array.from(host.querySelectorAll("canvas")).find((c) =>
        c.getContext("webgl2"),
      )!;
      const buffer = terminal.buffer.active;
      terminal.focus();
      expect(document.activeElement).toBe(terminal.textarea);
      const original = (Element.prototype as { moveBefore?: unknown }).moveBefore;
      if (!native) (to as unknown as { moveBefore?: unknown }).moveBefore = undefined;
      moveTerminalViewHost(to, host);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await write(terminal, "!");
      expect(host.parentElement).toBe(to);
      expect(terminal.buffer.active).toBe(buffer);
      expect(terminal.buffer.normal.getLine(0)?.translateToString(true)).toBe("hello");
      expect(terminal.buffer.active.getLine(1)?.translateToString(true)).toBe("     TUI!");
      expect(canvas.getContext("webgl2")!.isContextLost()).toBe(false);
      expect(host.contains(canvas)).toBe(true);
      expect(lost).not.toHaveBeenCalled();
      // Native moveBefore keeps focus; the appendChild fallback restores it.
      expect(document.activeElement).toBe(terminal.textarea);
      expect(typeof original).toBe("function");
      terminal.dispose();
    },
  );
});

function fakeClock() {
  let now = 1_000;
  const timers: Array<{ at: number; callback: () => void; handle: number }> = [];
  let next = 0;
  const clock: TerminalViewRegistryClock = {
    now: () => now,
    setTimeout: (callback, delay) => {
      const handle = ++next;
      timers.push({ at: now + delay, callback, handle });
      return handle;
    },
    clearTimeout: (handle) => {
      const index = timers.findIndex((timer) => timer.handle === handle);
      if (index !== -1) timers.splice(index, 1);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const timer of timers.filter((candidate) => candidate.at <= now)) {
      timers.splice(timers.indexOf(timer), 1);
      timer.callback();
    }
  };
  return { clock, advance };
}

const props = (threadId: string, terminalId: string): TerminalViewportProps => ({
  threadId: ThreadId.makeUnsafe(threadId),
  terminalId,
  terminalLabel: terminalId,
  visible: true,
  cwd: "/repo",
  onSessionExited: vi.fn(),
  onAddTerminalContext: vi.fn(),
  focusRequestId: 0,
  autoFocus: true,
  resizeEpoch: 0,
  drawerHeight: 300,
  keybindings: [],
});

describe("TerminalViewRegistry", () => {
  function setup() {
    const { clock, advance } = fakeClock();
    const registry = new TerminalViewRegistry(clock);
    const holder = box();
    registry.attachHolder(holder);
    return { registry, holder, advance };
  }

  it("moves one host between slots, waits in the holder, and parks only restorable cold views", () => {
    const { registry, holder, advance } = setup();
    const slot = box();
    const borrow = registry.acquire(slot, props("a", "pane"));
    const [entry] = registry.getMountedEntries();
    expect(entry!.host.parentElement).toBe(slot);
    expect(registry.viewState("a", "pane")).toBe("attached");
    borrow.release();
    expect(entry!.host.parentElement).toBe(holder);
    expect(registry.viewState("a", "pane")).toBe("warm");
    // Four newer surfaces push thread a out of the warm set.
    for (const thread of ["b", "c", "d", "e"]) registry.acquire(box(), props(thread, "pane"));
    advance(TERMINAL_VIEW_PARK_DELAY_MS);
    expect(registry.viewState("a", "pane")).toBe("warm"); // not restorable yet
    registry.setRestorable(JSON.stringify(["a", "pane"]), true);
    advance(1);
    expect(registry.viewState("a", "pane")).toBe("parked");
    expect(registry.getMountedEntries().map((mounted) => mounted.key)).not.toContain(
      JSON.stringify(["a", "pane"]),
    );
    // Reacquiring restores into the same host element.
    const back = box();
    registry.acquire(back, props("a", "pane"));
    expect(registry.viewState("a", "pane")).toBe("attached");
    expect(entry!.host.parentElement).toBe(back);
  });

  it("prefers a live borrower over an inert one and never shows or focuses an inert slot", () => {
    const { registry } = setup();
    const live = box();
    const hidden = box();
    hidden.inert = true;
    registry.acquire(live, props("a", "pane"));
    const inertBorrow = registry.acquire(hidden, props("a", "pane"));
    const key = JSON.stringify(["a", "pane"]);
    expect(registry.getMountedEntries()[0]!.host.parentElement).toBe(live);
    expect(registry.getEntryRender(key)).toMatchObject({ visible: true, autoFocus: true });
    inertBorrow.release();
    const only = box();
    only.inert = true;
    const other = registry.acquire(only, props("b", "pane"));
    expect(registry.getEntryRender(JSON.stringify(["b", "pane"]))).toMatchObject({
      visible: false,
      autoFocus: false,
    });
    expect(registry.visibleTerminalIds("b")).toEqual([]);
    expect(registry.visibleTerminalIds("a")).toEqual(["pane"]);
    other.release();
  });

  it("disposes a released view whose pane is gone, and reports visible panes", () => {
    const { registry } = setup();
    const listed = new Set(["a:keep", "a:closed"]);
    registry.setListedPredicate((thread, terminal) => listed.has(`${thread}:${terminal}`));
    const keep = registry.acquire(box(), props("a", "keep"));
    const closed = registry.acquire(box(), props("a", "closed"));
    expect(registry.visibleTerminalIds("a")).toEqual(["closed", "keep"]);
    listed.delete("a:closed");
    closed.release();
    expect(registry.viewState("a", "closed")).toBeNull();
    keep.release();
    expect(registry.visibleTerminalIds("a")).toEqual([]);
    expect(registry.viewState("a", "keep")).toBe("warm");
    listed.delete("a:keep");
    registry.prune();
    expect(registry.viewState("a", "keep")).toBeNull();
    expect(registry.getMountedEntries()).toHaveLength(0);
  });
});
