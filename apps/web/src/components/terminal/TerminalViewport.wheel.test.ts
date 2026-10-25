// Ported from Orca (stablyai/orca, MIT) src/renderer/src/lib/pane-manager/pane-terminal-mouse-wheel.test.ts at be4e0719.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachTerminalMouseWheelMultiplier,
  shouldMultiplyTerminalMouseWheel,
} from "./TerminalViewport.wheel";
import {
  DOM_DELTA_PIXEL,
  DOM_DELTA_LINE,
  TestWheelEvent,
  terminalElement,
  wheelEvent,
} from "./terminalTuiWheel.test.helpers";

describe("terminal mouse wheel replay", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("multiplies discrete wheel events when mouse reporting is active", () => {
    expect(shouldMultiplyTerminalMouseWheel(wheelEvent(), terminalElement())).toBe(true);
  });

  it("leaves normal terminal scrollback alone", () => {
    expect(shouldMultiplyTerminalMouseWheel(wheelEvent(), terminalElement(false))).toBe(false);
  });

  it("handles trackpad-like TUI pixel scrolling while mouse reporting is active", () => {
    expect(
      shouldMultiplyTerminalMouseWheel(
        wheelEvent({
          deltaY: 12,
          deltaMode: DOM_DELTA_PIXEL,
        }),
        terminalElement(),
      ),
    ).toBe(true);
  });

  it("multiplies notched mouse wheel ticks even when Chromium exposes a small pixel delta", () => {
    expect(
      shouldMultiplyTerminalMouseWheel(
        wheelEvent({
          deltaY: 12,
          deltaMode: DOM_DELTA_PIXEL,
          wheelDeltaY: -120,
        }),
        terminalElement(),
      ),
    ).toBe(true);
  });

  it("multiplies non-pixel wheel deltas as discrete input", () => {
    expect(
      shouldMultiplyTerminalMouseWheel(
        wheelEvent({
          deltaY: 1,
          deltaMode: DOM_DELTA_LINE,
        }),
        terminalElement(),
      ),
    ).toBe(true);
  });

  it("ignores horizontal shift-wheel events", () => {
    expect(
      shouldMultiplyTerminalMouseWheel(
        wheelEvent({
          shiftKey: true,
        }),
        terminalElement(),
      ),
    ).toBe(false);
  });

  it("replays discrete TUI wheel ticks as line-mode reports", async () => {
    vi.stubGlobal("WheelEvent", TestWheelEvent);
    const handlers: ((event: WheelEvent) => boolean)[] = [];
    const target = Object.assign(new EventTarget(), {
      classList: {
        contains: (className: string) => className === "enable-mouse-events",
      },
    }) as unknown as EventTarget & HTMLElement;
    const dispatched: WheelEvent[] = [];
    target.addEventListener("wheel", (event) => dispatched.push(event as WheelEvent));
    attachTerminalMouseWheelMultiplier(
      {
        attachCustomWheelEventHandler: (handler) => {
          handlers.push(handler);
        },
        element: target,
        modes: { mouseTrackingMode: "any" },
        rows: 24,
      },
      { getTuiMouseWheelMultiplier: () => 1 },
    );
    const event = new TestWheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaMode: DOM_DELTA_PIXEL,
      deltaY: 12,
    }) as WheelEvent;
    Object.defineProperty(event, "wheelDeltaY", {
      configurable: true,
      value: -120,
    });

    expect(handlers).toHaveLength(1);
    expect(handlers[0]?.(event)).toBe(false);
    await Promise.resolve();

    expect(dispatched).toHaveLength(1);
    expect(dispatched.map((entry) => entry.deltaMode)).toEqual([DOM_DELTA_LINE]);
    expect(dispatched.map((entry) => entry.deltaY)).toEqual([1]);
    expect(shouldMultiplyTerminalMouseWheel(dispatched[0]!, target)).toBe(false);
  });

  it("does not replay with a stale active mouse-reporting class", async () => {
    vi.stubGlobal("WheelEvent", TestWheelEvent);
    const handlers: ((event: WheelEvent) => boolean)[] = [];
    const target = Object.assign(new EventTarget(), {
      classList: {
        contains: (className: string) => className === "enable-mouse-events",
      },
    }) as unknown as EventTarget & HTMLElement;
    const dispatched: WheelEvent[] = [];
    target.addEventListener("wheel", (event) => dispatched.push(event as WheelEvent));
    const terminal = {
      attachCustomWheelEventHandler: (handler: (event: WheelEvent) => boolean) => {
        handlers.push(handler);
      },
      element: target,
      modes: { mouseTrackingMode: "none" as const },
      rows: 24,
    };
    attachTerminalMouseWheelMultiplier(terminal);

    const event = new TestWheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaMode: DOM_DELTA_PIXEL,
      deltaY: 12,
    }) as WheelEvent;
    Object.defineProperty(event, "wheelDeltaY", {
      configurable: true,
      value: -120,
    });

    expect(handlers[0]?.(event)).toBe(true);
    await Promise.resolve();

    expect(dispatched).toHaveLength(0);
  });

  it("discards pending replay when mouse reporting turns off before drain", async () => {
    vi.stubGlobal("WheelEvent", TestWheelEvent);
    const handlers: ((event: WheelEvent) => boolean)[] = [];
    const target = Object.assign(new EventTarget(), {
      classList: {
        contains: (className: string) => className === "enable-mouse-events",
      },
    }) as unknown as EventTarget & HTMLElement;
    const dispatched: WheelEvent[] = [];
    target.addEventListener("wheel", (event) => dispatched.push(event as WheelEvent));
    const terminal = {
      attachCustomWheelEventHandler: (handler: (event: WheelEvent) => boolean) => {
        handlers.push(handler);
      },
      element: target,
      modes: { mouseTrackingMode: "any" as "any" | "none" },
      rows: 24,
    };
    attachTerminalMouseWheelMultiplier(terminal);

    const event = new TestWheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaMode: DOM_DELTA_PIXEL,
      deltaY: 12,
    }) as WheelEvent;
    Object.defineProperty(event, "wheelDeltaY", {
      configurable: true,
      value: -120,
    });

    expect(handlers[0]?.(event)).toBe(false);
    terminal.modes.mouseTrackingMode = "none";
    await Promise.resolve();

    expect(dispatched).toHaveLength(0);
  });

  it("replays trackpad-like TUI pixel scrolling with responsive direction reversal", async () => {
    vi.stubGlobal("WheelEvent", TestWheelEvent);
    const handlers: ((event: WheelEvent) => boolean)[] = [];
    const target = Object.assign(new EventTarget(), {
      classList: {
        contains: (className: string) => className === "enable-mouse-events",
      },
    }) as unknown as EventTarget & HTMLElement;
    const dispatched: WheelEvent[] = [];
    target.addEventListener("wheel", (event) => dispatched.push(event as WheelEvent));
    attachTerminalMouseWheelMultiplier(
      {
        attachCustomWheelEventHandler: (handler) => {
          handlers.push(handler);
        },
        element: target,
        modes: { mouseTrackingMode: "any" },
        rows: 24,
      },
      { getTuiMouseWheelMultiplier: () => 1 },
    );

    const events = [
      [4, 0],
      [4, 16],
      [4, 32],
      [4, 48],
      [-4, 64],
      [-4, 80],
      [-4, 96],
      [-4, 112],
    ].map(([deltaY = 0, timeStamp = 0]) => {
      const event = new TestWheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaMode: DOM_DELTA_PIXEL,
        deltaY,
      }) as WheelEvent;
      Object.defineProperty(event, "timeStamp", {
        configurable: true,
        value: timeStamp,
      });
      return event;
    });

    for (const event of events) {
      expect(handlers[0]?.(event)).toBe(false);
      await Promise.resolve();
    }

    expect(dispatched.map((entry) => entry.deltaY)).toEqual([1, -1]);
  });

  it("replays a fast trackpad-like flick as one full synthetic report batch", async () => {
    vi.stubGlobal("WheelEvent", TestWheelEvent);
    const handlers: ((event: WheelEvent) => boolean)[] = [];
    const target = Object.assign(new EventTarget(), {
      classList: {
        contains: (className: string) => className === "enable-mouse-events",
      },
    }) as unknown as EventTarget & HTMLElement;
    const dispatched: WheelEvent[] = [];
    target.addEventListener("wheel", (event) => dispatched.push(event as WheelEvent));
    attachTerminalMouseWheelMultiplier(
      {
        attachCustomWheelEventHandler: (handler) => {
          handlers.push(handler);
        },
        element: target,
        modes: { mouseTrackingMode: "any" },
        rows: 24,
      },
      { getTuiMouseWheelMultiplier: () => 1 },
    );

    const event = new TestWheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaMode: DOM_DELTA_PIXEL,
      deltaY: 16 * 12,
    }) as WheelEvent;

    expect(handlers[0]?.(event)).toBe(false);
    await Promise.resolve();

    expect(dispatched.map((entry) => entry.deltaY)).toEqual(Array(12).fill(1));
  });

  it("drains resolved TUI wheel reports without a frame-rate cap", async () => {
    vi.stubGlobal("WheelEvent", TestWheelEvent);
    const handlers: ((event: WheelEvent) => boolean)[] = [];
    const target = Object.assign(new EventTarget(), {
      classList: {
        contains: (className: string) => className === "enable-mouse-events",
      },
    }) as unknown as EventTarget & HTMLElement;
    const dispatched: WheelEvent[] = [];
    target.addEventListener("wheel", (event) => dispatched.push(event as WheelEvent));
    attachTerminalMouseWheelMultiplier(
      {
        attachCustomWheelEventHandler: (handler) => {
          handlers.push(handler);
        },
        element: target,
        modes: { mouseTrackingMode: "any" },
        rows: 24,
      },
      {
        getTuiMouseWheelMultiplier: () => 3,
      },
    );
    const firstEvent = new TestWheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaMode: DOM_DELTA_PIXEL,
      deltaY: 12,
    }) as WheelEvent;
    Object.defineProperty(firstEvent, "wheelDeltaY", {
      configurable: true,
      value: -120,
    });
    Object.defineProperty(firstEvent, "timeStamp", {
      configurable: true,
      value: 0,
    });
    const secondEvent = new TestWheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaMode: DOM_DELTA_PIXEL,
      deltaY: 12,
    }) as WheelEvent;
    Object.defineProperty(secondEvent, "wheelDeltaY", {
      configurable: true,
      value: -120,
    });
    Object.defineProperty(secondEvent, "timeStamp", {
      configurable: true,
      value: 50,
    });

    expect(handlers[0]?.(firstEvent)).toBe(false);
    await Promise.resolve();
    expect(dispatched).toHaveLength(3);

    expect(handlers[0]?.(secondEvent)).toBe(false);
    await Promise.resolve();
    expect(dispatched).toHaveLength(6);
  });
});
