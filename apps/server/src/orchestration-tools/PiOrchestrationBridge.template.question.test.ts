import { describe, expect, it, vi } from "vitest";

import { renderPiOrchestrationBridgeSource } from "./PiOrchestrationBridge.template.ts";
import {
  PI_ASK_USER_TOOL_DESCRIPTION,
  PI_ASK_USER_TOOL_NAME,
  renderPiAskUserToolSource,
} from "./PiOrchestrationBridge.template.question.ts";

interface AskUserTool {
  name: string;
  execute: (
    toolCallId: string,
    params: { question: string; options?: string[] },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content: Array<{ text: string }> }>;
}

const textResult = (text: string) => ({ content: [{ type: "text", text }] });

/** Evaluates the rendered tool with the same globals the bridge provides. */
function loadAskUserTool(): AskUserTool {
  const type = new Proxy(
    {},
    {
      get:
        () =>
        (...args: unknown[]) => ({ args }),
    },
  );
  // oxlint-disable-next-line no-new-func
  const factory = new Function(
    "defineTool",
    "Type",
    "textResult",
    `${renderPiAskUserToolSource()}\nreturn askUserTool;`,
  );
  return factory((tool: AskUserTool) => tool, type, textResult) as AskUserTool;
}

const text = (result: { content: Array<{ text: string }> }) => result.content[0]!.text;

describe("Pi ask_user bridge tool", () => {
  it("asks through Pi's select dialog with de-duplicated choices and returns the pick", async () => {
    const select = vi.fn(async () => "Staging");
    const signal = new AbortController().signal;
    const result = await loadAskUserTool().execute(
      "call-1",
      {
        question: " Where should this deploy? ",
        options: ["Staging", " Staging", "Production", " "],
      },
      signal,
      undefined,
      { hasUI: true, ui: { select, input: vi.fn() } },
    );
    expect(select).toHaveBeenCalledWith("Where should this deploy?", ["Staging", "Production"], {
      signal,
    });
    expect(text(result)).toBe("The user answered: Staging");
  });

  it("asks for free text without options and reports a dismissal", async () => {
    const input = vi.fn(async () => undefined);
    const result = await loadAskUserTool().execute(
      "call-2",
      { question: "Which branch?" },
      undefined,
      undefined,
      { hasUI: true, ui: { select: vi.fn(), input } },
    );
    expect(input).toHaveBeenCalledWith("Which branch?", undefined, undefined);
    expect(text(result)).toBe("The user dismissed the question without answering.");
  });

  it("tells the model to assume when no UI is attached", async () => {
    const result = await loadAskUserTool().execute(
      "call-3",
      { question: "Proceed?" },
      undefined,
      undefined,
      { hasUI: false },
    );
    expect(text(result)).toContain("Make a reasonable assumption");
  });

  it("is registered in the rendered Pi bridge", () => {
    const source = renderPiOrchestrationBridgeSource({
      host: "127.0.0.1",
      port: 3773,
      threadId: "thread-1",
      token: "token-1",
    });
    expect(source).toContain(`name: ${JSON.stringify(PI_ASK_USER_TOOL_NAME)},`);
    expect(source).toContain("pi.registerTool(askUserTool);");
  });

  it("tells the model that Pi's select is single-choice", () => {
    // Pi has no multi-select dialog, so "select all that apply" can never be honoured.
    expect(PI_ASK_USER_TOOL_DESCRIPTION).toContain(
      'A question with options is always single-choice: never word it as "select all that apply"',
    );
  });
});
