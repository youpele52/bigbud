import { describe, expect, it } from "vitest";

import {
  TERMINAL_LAYOUT_LABELS,
  resolveEffectiveTerminalLayoutMode,
  resolveTerminalLayoutVisibility,
} from "./terminalLayout.logic";

describe("terminal layout", () => {
  it("displays chat-only while closed and defaults to split without a selection", () => {
    expect(
      resolveEffectiveTerminalLayoutMode({
        terminalOpen: false,
        selection: "terminal-only",
      }),
    ).toBe("chat-only");
    expect(
      resolveEffectiveTerminalLayoutMode({
        terminalOpen: true,
        selection: undefined,
      }),
    ).toBe("split");
  });

  it("resolves visibility without closing the logical terminal session", () => {
    expect(resolveTerminalLayoutVisibility("split")).toEqual({
      chatVisible: true,
      terminalPresentation: "split",
    });
    expect(resolveTerminalLayoutVisibility("terminal-only")).toEqual({
      chatVisible: false,
      terminalPresentation: "fill",
    });
    expect(resolveTerminalLayoutVisibility("chat-only")).toEqual({
      chatVisible: true,
      terminalPresentation: "hidden",
    });
  });

  it.each(["split", "terminal-only", "chat-only"] as const)(
    "preserves the selected %s layout while open",
    (mode) => {
      expect(
        resolveEffectiveTerminalLayoutMode({
          terminalOpen: true,
          selection: mode,
        }),
      ).toBe(mode);
    },
  );

  it("offers explicit layouts in display order", () => {
    expect(Object.entries(TERMINAL_LAYOUT_LABELS)).toEqual([
      ["chat-only", "Chat only"],
      ["split", "Chat + terminal"],
      ["terminal-only", "Terminal only"],
    ]);
  });
});
