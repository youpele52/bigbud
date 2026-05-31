import { describe, expect, it } from "vitest";

import { MessageId, ThreadId, ProjectId } from "@bigbud/contracts";
import type { Thread } from "../../models/types";
import {
  normalizeQuery,
  getSnippet,
  highlightMatch,
  findThreadSearchMatch,
  findMessageSearchMatches,
} from "./SearchPalette.logic";

function createMockThread(overrides: Partial<Thread> & { id: string }): Thread {
  const baseThread: Thread = {
    id: overrides.id as ThreadId,
    codexThreadId: null,
    projectId: (overrides.projectId ?? "project-1") as ProjectId,
    title: overrides.title ?? "Untitled Thread",
    modelSelection: { provider: "codex", model: "gpt-4o" },
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-01-01T00:00:00Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
  };

  return { ...baseThread, ...overrides };
}

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

describe("findThreadSearchMatch", () => {
  const thread = createMockThread({
    id: "thread-1" as ThreadId,
    title: "Database Schema",
    messages: [
      {
        id: "msg-1" as MessageId,
        role: "user",
        text: "First note",
        createdAt: "2026-01-01T00:00:00Z",
        attachments: [],
        streaming: false,
      },
      {
        id: "msg-2" as MessageId,
        role: "assistant",
        text: "Order number 48291 failed validation",
        createdAt: "2026-01-01T00:01:00Z",
        attachments: [],
        streaming: false,
      },
    ],
  });

  it("matches thread titles", () => {
    expect(findThreadSearchMatch(thread, "schema")).toEqual({
      matches: true,
      matchedMessageText: "",
    });
  });

  it("matches message text anywhere in the thread", () => {
    expect(findThreadSearchMatch(thread, "48291")).toEqual({
      matches: true,
      matchedMessageText: "Order number 48291 failed validation",
    });
  });

  it("is case-insensitive for thread messages", () => {
    expect(findThreadSearchMatch(thread, "VALIDATION")).toEqual({
      matches: true,
      matchedMessageText: "Order number 48291 failed validation",
    });
  });

  it("returns no match when neither title nor messages contain the query", () => {
    expect(findThreadSearchMatch(thread, "xyz123")).toEqual({
      matches: false,
      matchedMessageText: "",
    });
  });
});

describe("findMessageSearchMatches", () => {
  const thread = createMockThread({
    id: "thread-2" as ThreadId,
    title: "Search Thread",
    messages: [
      {
        id: "msg-1" as MessageId,
        role: "user",
        text: "alpha 123",
        createdAt: "2026-01-01T00:00:00Z",
        attachments: [],
        streaming: false,
      },
      {
        id: "msg-2" as MessageId,
        role: "assistant",
        text: "beta 456",
        createdAt: "2026-01-01T00:01:00Z",
        attachments: [],
        streaming: false,
      },
    ],
  });

  it("returns every matching message in a thread", () => {
    expect(findMessageSearchMatches(thread, "a")).toHaveLength(2);
  });

  it("finds numeric matches", () => {
    expect(findMessageSearchMatches(thread, "456")).toEqual([
      {
        messageId: "msg-2" as MessageId,
        text: "beta 456",
        snippet: "beta 456",
        matchIndex: 5,
      },
    ]);
  });

  it("returns empty array for null threads", () => {
    expect(findMessageSearchMatches(null, "alpha")).toEqual([]);
  });
});
