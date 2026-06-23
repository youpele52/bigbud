import { ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  appendTerminalContextsToPrompt,
  buildTerminalContextPreviewTitle,
  buildTerminalContextBlock,
  countInlineTerminalContextPlaceholders,
  deriveDisplayedUserMessageState,
  ensureInlineTerminalContextPlaceholders,
  extractTrailingTerminalContexts,
  filterTerminalContextsWithText,
  formatInlineTerminalContextLabel,
  formatTerminalContextLabel,
  hasTerminalContextText,
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  insertInlineTerminalContextPlaceholder,
  isTerminalContextExpired,
  materializeInlineTerminalContextPrompt,
  removeInlineTerminalContextPlaceholder,
  stripInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "./terminalContext";

function makeContext(overrides?: Partial<TerminalContextDraft>): TerminalContextDraft {
  return {
    id: "context-1",
    threadId: ThreadId.makeUnsafe("thread-1"),
    terminalId: "default",
    terminalLabel: "Terminal 1",
    lineStart: 12,
    lineEnd: 13,
    text: "git status\nOn branch main",
    createdAt: "2026-03-13T12:00:00.000Z",
    ...overrides,
  };
}

describe("terminalContext", () => {
  it("formats terminal labels with line ranges", () => {
    expect(formatTerminalContextLabel(makeContext())).toBe("Terminal 1 lines 12-13");
    expect(
      formatTerminalContextLabel(
        makeContext({
          lineStart: 9,
          lineEnd: 9,
        }),
      ),
    ).toBe("Terminal 1 line 9");
  });

  it("builds a numbered terminal context block", () => {
    expect(buildTerminalContextBlock([makeContext()])).toBe(
      [
        "<terminal_context>",
        "- Terminal 1 lines 12-13:",
        "  12 | git status",
        "  13 | On branch main",
        "</terminal_context>",
      ].join("\n"),
    );
  });

  it("appends terminal context blocks after prompt text", () => {
    expect(appendTerminalContextsToPrompt("Investigate this", [makeContext()])).toBe(
      [
        "Investigate this",
        "",
        "<terminal_context>",
        "- Terminal 1 lines 12-13:",
        "  12 | git status",
        "  13 | On branch main",
        "</terminal_context>",
      ].join("\n"),
    );
  });

  it("replaces inline placeholders with inline terminal labels before appending context blocks", () => {
    expect(
      appendTerminalContextsToPrompt(
        `Investigate ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} carefully`,
        [makeContext()],
      ),
    ).toBe(
      [
        "Investigate @terminal-1:12-13 carefully",
        "",
        "<terminal_context>",
        "- Terminal 1 lines 12-13:",
        "  12 | git status",
        "  13 | On branch main",
        "</terminal_context>",
      ].join("\n"),
    );
  });

  it("extracts terminal context blocks from message text", () => {
    const prompt = appendTerminalContextsToPrompt("Investigate this", [makeContext()]);
    expect(extractTrailingTerminalContexts(prompt)).toEqual({
      promptText: "Investigate this",
      contextCount: 1,
      previewTitle: "Terminal 1 lines 12-13\n12 | git status\n13 | On branch main",
      contexts: [
        {
          header: "Terminal 1 lines 12-13",
          body: "12 | git status\n13 | On branch main",
        },
      ],
    });
  });

  it("derives displayed user message state from terminal context prompts", () => {
    const prompt = appendTerminalContextsToPrompt("Investigate this", [makeContext()]);
    expect(deriveDisplayedUserMessageState(prompt)).toEqual({
      visibleText: "Investigate this",
      copyText: prompt,
      contextCount: 1,
      previewTitle: "Terminal 1 lines 12-13\n12 | git status\n13 | On branch main",
      contexts: [
        {
          header: "Terminal 1 lines 12-13",
          body: "12 | git status\n13 | On branch main",
        },
      ],
      annotations: [],
      readDocument: null,
    });
  });

  it("preserves prompt text when no trailing terminal context block exists", () => {
    expect(extractTrailingTerminalContexts("No attached context")).toEqual({
      promptText: "No attached context",
      contextCount: 0,
      previewTitle: null,
      contexts: [],
    });
  });

  it("returns null preview title when every context is invalid", () => {
    expect(
      buildTerminalContextPreviewTitle([
        makeContext({
          terminalId: "   ",
        }),
        makeContext({
          id: "context-2",
          text: "\n\n",
        }),
      ]),
    ).toBeNull();
  });

  it("hides trailing browser annotation blocks from visible user message text", () => {
    const annotation = [
      "Browser annotation",
      "",
      "User instruction:",
      "Fix this button",
      "",
      "Page:",
      "Title: Dashboard",
      "URL: https://example.com/dashboard",
      "Viewport: width=1280 height=720 devicePixelRatio=2",
      "",
      "Selected element:",
      "Selector: #save",
      "Tag: button",
      "Role: button",
      "Text: Save",
      "Aria label: Save changes",
      "Rect: x=10 y=20 width=100 height=32",
      "",
      "Use the attached screenshot and selected element metadata to make the appropriate code change.",
    ].join("\n");
    const prompt = `Please inspect\n\n${annotation}\n\n---\n\n${annotation}`;

    expect(deriveDisplayedUserMessageState(prompt)).toMatchObject({
      visibleText: "Please inspect",
      copyText: prompt,
      annotations: [
        { kind: "browser", text: annotation },
        { kind: "browser", text: annotation },
      ],
      readDocument: null,
    });
  });

  it("hides trailing code annotation blocks from visible user message text", () => {
    const annotation = [
      "Code annotation",
      "",
      "User instruction:",
      "Extract this into a helper",
      "",
      "File:",
      "Project: bigbud",
      "Workspace: /Users/youpele/DevWorld/bigbud",
      "Path: apps/web/src/main.ts",
      "Lines: 20-22",
      "",
      "Selected code:",
      "```",
      "const value = createValue();",
      "```",
      "",
      "Use the selected code and user instruction to make the appropriate code change.",
    ].join("\n");
    const prompt = `Please inspect\n\n${annotation}`;

    expect(deriveDisplayedUserMessageState(prompt)).toMatchObject({
      visibleText: "Please inspect",
      copyText: prompt,
      annotations: [
        {
          kind: "code",
          text: annotation,
          comment: "Extract this into a helper",
          projectName: "bigbud",
          workspace: "/Users/youpele/DevWorld/bigbud",
          path: "apps/web/src/main.ts",
          lineLabel: "Lines 20-22",
          selectedCode: "const value = createValue();",
        },
      ],
      readDocument: null,
    });
  });

  it("hides trailing terminal annotation blocks from visible user message text", () => {
    const annotation = [
      "Terminal annotation",
      "",
      "User instruction:",
      "Explain this failure",
      "",
      "Terminal:",
      "Label: Terminal 1",
      "ID: terminal-1",
      "Lines: 12-13",
      "",
      "Selected output:",
      "```",
      "error: build failed",
      "exit code 1",
      "```",
    ].join("\n");
    const prompt = `Please inspect\n\n${annotation}`;

    expect(deriveDisplayedUserMessageState(prompt)).toMatchObject({
      visibleText: "Please inspect",
      copyText: prompt,
      annotations: [
        {
          kind: "terminal",
          text: annotation,
          comment: "Explain this failure",
          terminalLabel: "Terminal 1",
          terminalId: "terminal-1",
          lineLabel: "Lines 12-13",
          selectedOutput: "error: build failed\nexit code 1",
        },
      ],
      readDocument: null,
    });
  });

  it("hides trailing read-document payloads from the visible user message text", () => {
    const prompt = [
      "Read this document URL and use the extracted contents below.",
      "",
      "<read_document_result>",
      "Source URL: https://example.com/report",
      "Resolved URL: https://cdn.example.com/report.pdf",
      "Title: Report",
      "<document_contents>",
      "First line",
      "",
      "Second line",
      "</document_contents>",
      "</read_document_result>",
    ].join("\n");

    expect(deriveDisplayedUserMessageState(prompt)).toEqual({
      visibleText: "Read this document URL and use the extracted contents below.",
      copyText: prompt,
      contextCount: 0,
      previewTitle: null,
      contexts: [],
      annotations: [],
      readDocument: {
        sourceUrl: "https://example.com/report",
        resolvedUrl: "https://cdn.example.com/report.pdf",
        title: "Report",
        text: "First line\n\nSecond line",
      },
    });
  });

  it("tracks inline terminal context placeholders in prompt text", () => {
    const placeholder = INLINE_TERMINAL_CONTEXT_PLACEHOLDER;
    expect(countInlineTerminalContextPlaceholders(`a${placeholder}b${placeholder}`)).toBe(2);
    expect(ensureInlineTerminalContextPlaceholders("Investigate this", 2)).toBe(
      `${placeholder}${placeholder}Investigate this`,
    );
    expect(insertInlineTerminalContextPlaceholder("abc", 1)).toEqual({
      prompt: `a ${placeholder} bc`,
      cursor: 4,
      contextIndex: 0,
    });
    expect(removeInlineTerminalContextPlaceholder(`a${placeholder}b${placeholder}c`, 1)).toEqual({
      prompt: `a${placeholder}bc`,
      cursor: 3,
    });
    expect(stripInlineTerminalContextPlaceholders(`a${placeholder}b`)).toBe("ab");
  });

  it("inserts a placeholder after a file mention when given the expanded prompt cursor", () => {
    const placeholder = INLINE_TERMINAL_CONTEXT_PLACEHOLDER;
    expect(insertInlineTerminalContextPlaceholder("Inspect @package.json ", 22)).toEqual({
      prompt: `Inspect @package.json ${placeholder} `,
      cursor: 24,
      contextIndex: 0,
    });
  });

  it("adds a trailing space and consumes an existing trailing space at the insertion point", () => {
    const placeholder = INLINE_TERMINAL_CONTEXT_PLACEHOLDER;
    expect(insertInlineTerminalContextPlaceholder("yo whats", 3)).toEqual({
      prompt: `yo ${placeholder} whats`,
      cursor: 5,
      contextIndex: 0,
    });
  });

  it("marks contexts without snapshot text as expired and filters them from sendable contexts", () => {
    const liveContext = makeContext();
    const expiredContext = makeContext({
      id: "context-2",
      text: "",
    });

    expect(hasTerminalContextText(liveContext)).toBe(true);
    expect(isTerminalContextExpired(liveContext)).toBe(false);
    expect(hasTerminalContextText(expiredContext)).toBe(false);
    expect(isTerminalContextExpired(expiredContext)).toBe(true);
    expect(filterTerminalContextsWithText([expiredContext, liveContext])).toEqual([liveContext]);
  });

  it("formats and materializes inline terminal labels from placeholder positions", () => {
    expect(formatInlineTerminalContextLabel(makeContext())).toBe("@terminal-1:12-13");
    expect(
      materializeInlineTerminalContextPrompt(
        `Investigate ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} carefully`,
        [makeContext()],
      ),
    ).toBe("Investigate @terminal-1:12-13 carefully");
  });
});
