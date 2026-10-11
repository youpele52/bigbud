import { describe, expect, it } from "vitest";

import {
  TERMINAL_LAYOUT_LABELS,
  resolveEffectiveTerminalLayoutMode,
  resolveTerminalLayoutVisibility,
} from "./terminalLayout.logic";

describe("terminal layout", () => {
  it("displays chat-only while closed and resets to split after identity changes", () => {
    const selection = { threadId: "thread-a", epoch: 2, mode: "terminal-only" as const };

    expect(
      resolveEffectiveTerminalLayoutMode({
        terminalOpen: false,
        activeThreadId: "thread-a",
        activeEpoch: 2,
        selection,
      }),
    ).toBe("chat-only");
    expect(
      resolveEffectiveTerminalLayoutMode({
        terminalOpen: true,
        activeThreadId: "thread-b",
        activeEpoch: 3,
        selection,
      }),
    ).toBe("split");
    expect(
      resolveEffectiveTerminalLayoutMode({
        terminalOpen: true,
        activeThreadId: "thread-a",
        activeEpoch: 3,
        selection,
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
          activeThreadId: "thread-a",
          activeEpoch: 2,
          selection: { threadId: "thread-a", epoch: 2, mode },
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
