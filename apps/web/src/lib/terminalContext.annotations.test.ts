import { describe, expect, it } from "vitest";

import { buildTerminalAnnotationPrompt } from "../components/chat/view/ChatView.annotations.logic";
import { extractTrailingAnnotations } from "./terminalContext.annotations";

function makeTerminalAnnotationPrompt(input?: {
  comment?: string;
  intent?: "ask" | "context" | "fix" | "comment";
  lineStart?: number;
  lineEnd?: number;
  text?: string;
}): string {
  return buildTerminalAnnotationPrompt({
    id: "terminal-annotation-1",
    kind: "terminal",
    comment: input?.comment ?? "Explain this failure",
    intent: input?.intent ?? "ask",
    createdAt: "2026-06-23T00:00:00.000Z",
    terminal: {
      terminalId: "terminal-1",
      terminalLabel: "Terminal 1",
    },
    selection: {
      startLine: input?.lineStart ?? 12,
      endLine: input?.lineEnd ?? 13,
      text: input?.text ?? "error: build failed\nexit code 1",
    },
  });
}

describe("terminalContext.annotations", () => {
  it("extracts terminal annotation blocks from trailing prompt text", () => {
    const annotation = makeTerminalAnnotationPrompt();
    const prompt = `Please inspect\n\n${annotation}`;

    expect(extractTrailingAnnotations(prompt)).toEqual({
      promptText: "Please inspect",
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
    });
  });

  it("parses single-line terminal annotations", () => {
    const annotation = makeTerminalAnnotationPrompt({
      lineStart: 8,
      lineEnd: 8,
      text: "npm ERR! missing script: test",
    });

    expect(extractTrailingAnnotations(annotation).annotations[0]).toMatchObject({
      kind: "terminal",
      lineLabel: "Line 8",
      selectedOutput: "npm ERR! missing script: test",
    });
  });
});
