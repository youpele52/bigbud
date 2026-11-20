import { describe, expect, it } from "vitest";
import { TERMINAL_VIEW_LEASE_MS } from "@bigbud/contracts/workspace/terminal.activity.ts";
import { TerminalViewRegistry } from "./terminalViewRegistry.ts";

describe("TerminalViewRegistry", () => {
  it("reports a newly opened thread once and every viewed pane", () => {
    const views = new TerminalViewRegistry();
    expect(views.update("c1", { threadId: "t" as never, terminalIds: ["a"] }, 0)).toEqual({
      openedThreadId: "t",
      viewedPanes: [{ threadId: "t", terminalId: "a" }],
    });
    expect(
      views.update("c1", { threadId: "t" as never, terminalIds: ["a"] }, 1_000).openedThreadId,
    ).toBeNull();
    expect(views.isViewed("t", "a", 1_000)).toBe(true);
    expect(views.isViewed("t", "b", 1_000)).toBe(false);
  });

  it("stops counting after the lease, on hide and on disconnect", () => {
    const views = new TerminalViewRegistry();
    views.update("c1", { threadId: "t" as never, terminalIds: ["a"] }, 0);
    expect(views.isViewed("t", "a", TERMINAL_VIEW_LEASE_MS)).toBe(false);
    views.update("c1", { threadId: "t" as never, terminalIds: ["a"] }, 0);
    views.update("c1", { threadId: null, terminalIds: [] }, 1);
    expect(views.isViewed("t", "a", 2)).toBe(false);
    views.update("c2", { threadId: "t" as never, terminalIds: ["a"] }, 0);
    views.forget("c2");
    expect(views.isViewed("t", "a", 1)).toBe(false);
  });

  it("treats returning to a thread after hiding as opening it", () => {
    const views = new TerminalViewRegistry();
    views.update("c1", { threadId: "t" as never, terminalIds: [] }, 0);
    views.update("c1", { threadId: null, terminalIds: [] }, 1);
    expect(views.update("c1", { threadId: "t" as never, terminalIds: [] }, 2).openedThreadId).toBe(
      "t",
    );
  });
});
