import { describe, expect, it } from "vitest";

import { DEFAULT_THREAD_TITLE, fallbackThreadTitleFromPrompt, truncate } from "./String";

describe("truncate", () => {
  it("trims surrounding whitespace", () => {
    expect(truncate("   hello world   ")).toBe("hello world");
  });

  it("returns shorter strings unchanged", () => {
    expect(truncate("alpha", 10)).toBe("alpha");
  });

  it("truncates long strings and appends an ellipsis", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcde...");
  });
});

describe("fallbackThreadTitleFromPrompt", () => {
  it("falls back to the default thread title for empty prompts", () => {
    expect(fallbackThreadTitleFromPrompt("   ")).toBe(DEFAULT_THREAD_TITLE);
  });

  it("collapses whitespace before building the fallback title", () => {
    expect(fallbackThreadTitleFromPrompt("  hello\n\nworld  ")).toBe("hello world");
  });

  it("truncates the first prompt to 25 characters", () => {
    expect(
      fallbackThreadTitleFromPrompt(
        "Please investigate reconnect failures after restarting the session.",
      ),
    ).toBe("Please investigate reconn...");
  });
});
