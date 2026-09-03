import { describe, expect, it } from "vitest";

import {
  cycleTerminalLayoutMode,
  resolveEffectiveTerminalLayoutMode,
  resolveTerminalLayoutVisibility,
  terminalLayoutNextActionLabel,
} from "./terminalLayout.logic";

describe("terminal layout", () => {
  it("cycles through split, terminal-only, chat-only, and split", () => {
    expect(cycleTerminalLayoutMode("split")).toBe("terminal-only");
    expect(cycleTerminalLayoutMode("terminal-only")).toBe("chat-only");
    expect(cycleTerminalLayoutMode("chat-only")).toBe("split");
  });

  it("uses split while closed or after the active thread identity changes", () => {
    const selection = { threadId: "thread-a", epoch: 2, mode: "terminal-only" as const };

    expect(
      resolveEffectiveTerminalLayoutMode({
        terminalOpen: false,
        activeThreadId: "thread-a",
        activeEpoch: 2,
        selection,
      }),
    ).toBe("split");
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

  it("provides exact next-action labels", () => {
    expect(terminalLayoutNextActionLabel("split")).toBe("Show terminal only");
    expect(terminalLayoutNextActionLabel("terminal-only")).toBe("Show chat only");
    expect(terminalLayoutNextActionLabel("chat-only")).toBe("Show split chat and terminal");
  });
});
