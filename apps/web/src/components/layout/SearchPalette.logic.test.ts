import { describe, expect, it } from "vitest";

import { normalizeQuery, getSnippet, highlightMatch } from "./SearchPalette.logic";

describe("normalizeQuery", () => {
  it("trims whitespace from query", () => {
    expect(normalizeQuery("  hello  ")).toBe("hello");
  });

  it("converts to lowercase", () => {
    expect(normalizeQuery("HELLO World")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(normalizeQuery("")).toBe("");
  });

  it("handles whitespace-only string", () => {
    expect(normalizeQuery("   ")).toBe("");
  });
});

describe("getSnippet", () => {
  it("returns full text when shorter than snippet length", () => {
    const shortText = "Short text";
    expect(getSnippet(shortText, 0, 70)).toBe(shortText);
  });

  it("centers snippet around match index", () => {
    const text = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const matchIndex = 12; // 'M'
    const snippet = getSnippet(text, matchIndex, 10);
    expect(snippet).toContain("M");
    expect(snippet.length).toBeLessThanOrEqual(16); // 10 + "..." on both sides (max)
  });

  it("adds ellipsis at start when not at beginning", () => {
    const text = "This is a very long text for testing ellipsis";
    const snippet = getSnippet(text, 20, 20);
    expect(snippet.startsWith("...")).toBe(true);
  });

  it("does not add ellipsis at start when at beginning", () => {
    const text = "Short text for testing";
    const snippet = getSnippet(text, 2, 50);
    expect(snippet.startsWith("...")).toBe(false);
  });

  it("adds ellipsis at end when not at end", () => {
    const text = "This is a very long text for testing end ellipsis";
    const snippet = getSnippet(text, 5, 20);
    expect(snippet.endsWith("...")).toBe(true);
  });

  it("does not add ellipsis at end when at end", () => {
    const text = "Short text";
    const snippet = getSnippet(text, 5, 50);
    expect(snippet.endsWith("...")).toBe(false);
  });

  it("handles match at start of text", () => {
    const text = "Start of text here";
    const snippet = getSnippet(text, 0, 20);
    expect(snippet.startsWith("Start")).toBe(true);
    expect(snippet.startsWith("...")).toBe(false);
  });

  it("handles match at end of text", () => {
    const text = "Text ending here";
    const snippet = getSnippet(text, 10, 20);
    expect(snippet.endsWith("here")).toBe(true);
    expect(snippet.endsWith("...")).toBe(false);
  });
});

describe("highlightMatch", () => {
  it("returns original text when query is empty", () => {
    const text = "Hello world";
    const result = highlightMatch(text, "");
    expect(result).toEqual({
      before: text,
      match: "",
      after: "",
      hasMatch: false,
    });
  });

  it("returns original text when no match found", () => {
    const text = "Hello world";
    const result = highlightMatch(text, "xyz");
    expect(result).toEqual({
      before: text,
      match: "",
      after: "",
      hasMatch: false,
    });
  });

  it("highlights single match", () => {
    const text = "Hello world";
    const result = highlightMatch(text, "world");
    expect(result).toEqual({
      before: "Hello ",
      match: "world",
      after: "",
      hasMatch: true,
    });
  });

  it("highlights first match only (case-insensitive)", () => {
    const text = "Hello hello hello";
    const result = highlightMatch(text, "hello");
    // First match is "Hello" at position 0 (case-insensitive search)
    expect(result).toEqual({
      before: "",
      match: "Hello",
      after: " hello hello",
      hasMatch: true,
    });
  });

  it("is case-insensitive", () => {
    const text = "HELLO World";
    const result = highlightMatch(text, "hello");
    expect(result).toEqual({
      before: "",
      match: "HELLO",
      after: " World",
      hasMatch: true,
    });
  });

  it("handles match at start of text", () => {
    const text = "Hello world";
    const result = highlightMatch(text, "Hello");
    expect(result).toEqual({
      before: "",
      match: "Hello",
      after: " world",
      hasMatch: true,
    });
  });

  it("handles match at end of text", () => {
    const text = "Hello world";
    const result = highlightMatch(text, "world");
    expect(result).toEqual({
      before: "Hello ",
      match: "world",
      after: "",
      hasMatch: true,
    });
  });
});
