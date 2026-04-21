import { describe, expect, it } from "vitest";

import {
  selectionTouchesMentionBoundary,
  splitPromptIntoComposerSegments,
} from "./editor-mentions.logic";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "../../lib/terminalContext";

describe("splitPromptIntoComposerSegments", () => {
  it("splits mention tokens followed by whitespace into mention segments", () => {
    expect(splitPromptIntoComposerSegments("Inspect @AGENTS.md please")).toEqual([
      { type: "text", text: "Inspect " },
      {
        type: "mention",
        rawValue: "AGENTS.md",
        displayLabel: "AGENTS.md",
        mentionKind: "path",
      },
      { type: "text", text: " please" },
    ]);
  });

  it("does not convert an incomplete trailing mention token", () => {
    expect(splitPromptIntoComposerSegments("Inspect @AGENTS.md")).toEqual([
      { type: "text", text: "Inspect @AGENTS.md" },
    ]);
  });

  it("keeps newlines around mention tokens", () => {
    expect(splitPromptIntoComposerSegments("one\n@src/index.ts \ntwo")).toEqual([
      { type: "text", text: "one\n" },
      {
        type: "mention",
        rawValue: "src/index.ts",
        displayLabel: "index.ts",
        mentionKind: "path",
      },
      { type: "text", text: " \ntwo" },
    ]);
  });

  it("keeps inline terminal context placeholders at their prompt positions", () => {
    expect(
      splitPromptIntoComposerSegments(
        `Inspect ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}@AGENTS.md please`,
      ),
    ).toEqual([
      { type: "text", text: "Inspect " },
      { type: "terminal-context", context: null },
      {
        type: "mention",
        rawValue: "AGENTS.md",
        displayLabel: "AGENTS.md",
        mentionKind: "path",
      },
      { type: "text", text: " please" },
    ]);
  });

  it("preserves consecutive terminal context placeholders without dropping positions", () => {
    expect(
      splitPromptIntoComposerSegments(
        `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}tail`,
      ),
    ).toEqual([
      { type: "terminal-context", context: null },
      { type: "terminal-context", context: null },
      { type: "text", text: "tail" },
    ]);
  });

  it("parses agent mentions with a short display label", () => {
    expect(splitPromptIntoComposerSegments("Use @agent::clarifier please")).toEqual([
      { type: "text", text: "Use " },
      {
        type: "mention",
        rawValue: "agent::clarifier",
        displayLabel: "clarifier",
        mentionKind: "agent",
      },
      { type: "text", text: " please" },
    ]);
  });

  it("parses skill mentions with a short display label", () => {
    expect(splitPromptIntoComposerSegments("Use @skill::review please")).toEqual([
      { type: "text", text: "Use " },
      {
        type: "mention",
        rawValue: "skill::review",
        displayLabel: "review",
        mentionKind: "skill",
      },
      { type: "text", text: " please" },
    ]);
  });

  it("parses a trailing agent mention when explicitly allowed", () => {
    expect(
      splitPromptIntoComposerSegments("Use @agent::clarifier", [], {
        allowTrailingAgentAndSkillMentions: true,
      }),
    ).toEqual([
      { type: "text", text: "Use " },
      {
        type: "mention",
        rawValue: "agent::clarifier",
        displayLabel: "clarifier",
        mentionKind: "agent",
      },
    ]);
  });

  it("parses a trailing skill mention when explicitly allowed", () => {
    expect(
      splitPromptIntoComposerSegments("Use @skill::review", [], {
        allowTrailingAgentAndSkillMentions: true,
      }),
    ).toEqual([
      { type: "text", text: "Use " },
      {
        type: "mention",
        rawValue: "skill::review",
        displayLabel: "review",
        mentionKind: "skill",
      },
    ]);
  });
});

describe("selectionTouchesMentionBoundary", () => {
  it("returns true when selection includes the whitespace after a mention", () => {
    expect(
      selectionTouchesMentionBoundary(
        "hi @package.json there",
        "hi @package.json".length,
        "hi @package.json there".length,
      ),
    ).toBe(true);
  });

  it("returns true when selection includes the whitespace before a mention", () => {
    expect(
      selectionTouchesMentionBoundary(
        "hi there @package.json later",
        "hi there".length,
        "hi there ".length,
      ),
    ).toBe(true);
  });

  it("returns false when selection starts after the mention boundary whitespace", () => {
    expect(
      selectionTouchesMentionBoundary(
        "hi @package.json there",
        "hi @package.json ".length,
        "hi @package.json there".length,
      ),
    ).toBe(false);
  });

  it("returns true when selection includes whitespace after a mention following a terminal placeholder", () => {
    const prompt = `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}@AGENTS.md there`;
    expect(
      selectionTouchesMentionBoundary(
        prompt,
        `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}@AGENTS.md`.length,
        prompt.length,
      ),
    ).toBe(true);
  });
});
