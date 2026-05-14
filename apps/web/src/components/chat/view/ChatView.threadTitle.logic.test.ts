import { describe, expect, it } from "vitest";

import { draftTitleFromMessage } from "./ChatView.threadTitle.logic";

describe("draftTitleFromMessage", () => {
  it("uses the first prompt text directly", () => {
    expect(draftTitleFromMessage("/plan investigate reconnect failures after restart")).toBe(
      "/plan investigate reconne...",
    );
  });

  it("collapses whitespace before truncating", () => {
    expect(draftTitleFromMessage("  hello\n\nworld  ")).toBe("hello world");
  });

  it("truncates to the first 25 characters", () => {
    expect(
      draftTitleFromMessage("Please investigate reconnect failures after restarting the session."),
    ).toBe("Please investigate reconn...");
  });

  it("falls back to New thread when the prompt has no title content", () => {
    expect(draftTitleFromMessage("   ")).toBe("New thread");
  });
});
