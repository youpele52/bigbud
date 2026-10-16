import { describe, expect, it } from "vitest";

import {
  normalizePromptSuggestion,
  readPromptSuggestionActivity,
  redactPromptSuggestionContext,
} from "./promptSuggestion";

const of = (length: number) => "a".repeat(length);

describe("normalizePromptSuggestion", () => {
  it("keeps 15 to 150 characters and drops anything outside, never truncating", () => {
    expect(normalizePromptSuggestion(of(14))).toBeNull();
    expect(normalizePromptSuggestion(of(15))).toBe(of(15));
    expect(normalizePromptSuggestion(of(150))).toBe(of(150));
    expect(normalizePromptSuggestion(of(151))).toBeNull();
  });

  it("measures the bounds after trimming and collapsing", () => {
    expect(normalizePromptSuggestion(`   ${of(15)}   `)).toBe(of(15));
    expect(normalizePromptSuggestion(`${of(7)}\n\n\t ${of(7)}`)).toBe(`${of(7)} ${of(7)}`);
  });

  it("collapses a multi-line suggestion to one line", () => {
    expect(normalizePromptSuggestion("Run the tests\nthen fix\r\nany failures")).toBe(
      "Run the tests then fix any failures",
    );
  });

  it("strips control, zero-width and bidi characters", () => {
    expect(normalizePromptSuggestion("Add\u202E a test for\u2066 the\u200B parser\u0007 now")).toBe(
      "Add a test for the parser now",
    );
    expect(normalizePromptSuggestion("\u202E\u2067\u200F\u0000")).toBeNull();
  });

  it("drops a suggestion equal to the last user message", () => {
    expect(
      normalizePromptSuggestion("Run the test suite again", {
        lastUserMessage: "  run the TEST suite\nagain ",
      }),
    ).toBeNull();
    expect(
      normalizePromptSuggestion("Run the test suite again", { lastUserMessage: "Run the tests" }),
    ).toBe("Run the test suite again");
  });

  it("rejects non-string input", () => {
    expect(normalizePromptSuggestion(undefined)).toBeNull();
    expect(normalizePromptSuggestion(42)).toBeNull();
  });
});

describe("readPromptSuggestionActivity", () => {
  it("reads only well-formed prompt suggestion activities", () => {
    const payload = { suggestion: "Add tests for the parser", source: "native", provider: "codex" };
    expect(readPromptSuggestionActivity({ kind: "prompt.suggestion", payload })).toEqual(payload);
    expect(readPromptSuggestionActivity({ kind: "tool.completed", payload })).toBeNull();
    expect(
      readPromptSuggestionActivity({ kind: "prompt.suggestion", payload: { suggestion: 1 } }),
    ).toBeNull();
  });
});

describe("redactPromptSuggestionContext", () => {
  it("redacts common secret forms and bounds the text", () => {
    const text = redactPromptSuggestionContext("use token=abc123 and sk_live_1234567890", 2_000);
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("sk_live_1234567890");
    expect(redactPromptSuggestionContext(of(50), 10).length).toBeLessThanOrEqual(10);
  });
});
