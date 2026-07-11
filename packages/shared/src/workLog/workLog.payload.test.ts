import { describe, expect, it } from "vitest";

import { extractWorkLogPayloadDetails } from "./workLog.payload";

describe("extractWorkLogPayloadDetails", () => {
  it("maps browser_approval request types to browser requestKind", () => {
    expect(
      extractWorkLogPayloadDetails({
        requestType: "browser_approval",
        detail: "Allow browser navigation",
      }),
    ).toEqual({
      requestKind: "browser",
      detail: "Allow browser navigation",
    });
  });

  it("preserves computer_use tool metadata from activity payloads", () => {
    expect(
      extractWorkLogPayloadDetails({
        itemType: "mcp_tool_call",
        title: "computer_use",
        detail: "Captured screenshot.",
      }),
    ).toEqual({
      itemType: "mcp_tool_call",
      toolTitle: "computer_use",
      detail: "Captured screenshot.",
    });
  });

  it("extracts browser actions from provider tool input", () => {
    expect(
      extractWorkLogPayloadDetails({
        itemType: "dynamic_tool_call",
        title: "bigbud_orchestration_thread-1_browser",
        data: { input: { action: "navigate" } },
      }),
    ).toEqual({
      itemType: "dynamic_tool_call",
      toolTitle: "bigbud_orchestration_thread-1_browser",
      toolAction: "navigate",
    });
  });

  it("uses the browser MCP tool name over a provider's generic title", () => {
    expect(
      extractWorkLogPayloadDetails({
        itemType: "mcp_tool_call",
        title: "MCP tool call",
        data: {
          toolName: "mcp__bigbud_orchestration__browser",
          input: { action: "capture" },
        },
      }),
    ).toEqual({
      itemType: "mcp_tool_call",
      toolTitle: "mcp__bigbud_orchestration__browser",
      toolAction: "capture",
    });
  });

  it("extracts attachmentUrl from computer-use tool data", () => {
    expect(
      extractWorkLogPayloadDetails({
        itemType: "mcp_tool_call",
        title: "computer_use",
        detail: "Computer use completed",
        data: {
          attachmentUrl: "/attachments/thread-1/screenshot-1.png",
        },
      }),
    ).toEqual({
      itemType: "mcp_tool_call",
      toolTitle: "computer_use",
      detail: "Computer use completed",
      attachmentUrl: "/attachments/thread-1/screenshot-1.png",
    });
  });

  it("extracts attachmentUrl from nested result.screenshot", () => {
    expect(
      extractWorkLogPayloadDetails({
        detail: "Computer use completed",
        data: {
          result: {
            screenshot: {
              attachmentUrl: "/attachments/thread-1/screenshot-2.png",
            },
          },
        },
      }),
    ).toEqual({
      detail: "Computer use completed",
      attachmentUrl: "/attachments/thread-1/screenshot-2.png",
    });
  });
});
