import { describe, expect, it, vi } from "vitest";

import { fitTerminalViewport } from "./TerminalViewport";

describe("fitTerminalViewport", () => {
  it("fits, scrolls, and resizes when the terminal viewport has usable size", () => {
    const fit = vi.fn();
    const scrollToBottom = vi.fn();
    const requestTerminalResize = vi.fn();

    fitTerminalViewport({
      container: {
        getBoundingClientRect: () =>
          ({
            width: 480,
            height: 320,
          }) as DOMRect,
      },
      terminal: {
        buffer: {
          active: {
            viewportY: 12,
            baseY: 12,
          },
        },
        scrollToBottom,
      } as never,
      fitAddon: { fit } as never,
      requestTerminalResize,
    });

    expect(fit).toHaveBeenCalledTimes(1);
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
    expect(requestTerminalResize).toHaveBeenCalledTimes(1);
  });

  it("skips fitting and resize requests when the viewport is too small", () => {
    const fit = vi.fn();
    const scrollToBottom = vi.fn();
    const requestTerminalResize = vi.fn();

    fitTerminalViewport({
      container: {
        getBoundingClientRect: () =>
          ({
            width: 24,
            height: 24,
          }) as DOMRect,
      },
      terminal: {
        buffer: {
          active: {
            viewportY: 0,
            baseY: 0,
          },
        },
        scrollToBottom,
      } as never,
      fitAddon: { fit } as never,
      requestTerminalResize,
    });

    expect(fit).not.toHaveBeenCalled();
    expect(scrollToBottom).not.toHaveBeenCalled();
    expect(requestTerminalResize).not.toHaveBeenCalled();
  });
});
