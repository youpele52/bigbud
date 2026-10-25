import { EventId, type OrchestrationThreadActivity } from "@bigbud/contracts";
import { deriveWorkLogEntries as deriveSharedWorkLogEntries } from "@bigbud/shared/workLog";
import { expect, it } from "vitest";

import {
  toolWorkEntryHeading,
  workEntryCopyText,
} from "../../components/chat/messages/MessagesTimeline.workEntry.logic";
import { deriveWorkLogEntries } from "./worklog.logic";
import { readOwnedToolPresentation } from "../../lib/toolPresentation.payload";

it.each([
  { toolName: "mcp__bigbud_orchestration__browser", input: { action: "navigate" } },
  {
    item: {
      type: "dynamicToolCall",
      namespace: "bigbud_orchestration",
      tool: "browser",
      arguments: '{"action":"navigate"}',
    },
  },
  {
    item: {
      type: "mcpToolCall",
      server: "bigbud_orchestration",
      tool: "browser",
      arguments: { action: "navigate" },
    },
  },
  {
    type: "tool",
    tool: "bigbud_orchestration_thread-1_browser",
    state: { input: { action: "navigate" } },
  },
])(
  "reads retained browser identity from provider metadata without rewriting raw activity: %j",
  (data) => {
    const activity: OrchestrationThreadActivity = {
      id: EventId.makeUnsafe("tool-meta"),
      createdAt: "2026-10-17T12:00:00Z",
      tone: "tool",
      kind: "tool.updated",
      summary: "Tool call",
      turnId: null,
      payload: { itemType: "mcp_tool_call", data },
    };
    const original = JSON.stringify(activity);
    const entry = deriveWorkLogEntries([activity], undefined)[0]!;
    expect(toolWorkEntryHeading(entry)).toBe("bigbud · navigating browser");
    expect(workEntryCopyText(entry)).toBe(entry.toolPresentation?.rawName);
    expect(JSON.stringify(activity)).toBe(original);
    expect(entry.toolTitle).toBe(deriveSharedWorkLogEntries([activity], undefined)[0]!.toolTitle);
  },
);

it.each([
  {
    item: {
      type: "mcpToolCall",
      server: "other",
      tool: "browser",
      arguments: { action: "navigate" },
    },
  },
  { name: "bigbud_thread_v1_rename_thread", action: "navigate" },
  { toolName: "third_party_browser", input: { action: "navigate" } },
  { item: { type: "mcpToolCall", server: "other_bigbud_orchestration", tool: "browser" } },
])("does not infer ownership from arbitrary input or another MCP server: %j", (data) => {
  const activity: OrchestrationThreadActivity = {
    id: EventId.makeUnsafe("tool-other"),
    createdAt: "2026-10-17T12:00:00Z",
    tone: "tool",
    kind: "tool.updated",
    summary: "Tool call",
    turnId: null,
    payload: { itemType: "mcp_tool_call", data },
  };
  const entry = deriveWorkLogEntries([activity], undefined)[0]!;
  expect(toolWorkEntryHeading(entry)).toBe("Tool call");
  expect(entry.toolPresentation).toBeUndefined();
});

it("keeps identity-free completed activities generic instead of guessing from tool results", () => {
  const entry = deriveWorkLogEntries(
    [
      {
        id: EventId.makeUnsafe("no-identity"),
        createdAt: "2026-10-17T12:00:00Z",
        tone: "tool",
        kind: "tool.completed",
        summary: "Tool call",
        turnId: null,
        payload: { itemType: "mcp_tool_call", detail: "Read bigbud browser docs" },
      },
    ],
    undefined,
  )[0]!;
  expect(toolWorkEntryHeading(entry)).toBe("Tool call");
});

it.each([
  { label: "malformed", argumentsValue: "not valid JSON" },
  { label: "oversized", argumentsValue: " ".repeat(65_537) },
])("ignores $label optional browser arguments", ({ argumentsValue }) => {
  expect(
    readOwnedToolPresentation({
      data: {
        item: {
          type: "dynamicToolCall",
          namespace: "bigbud_orchestration",
          tool: "browser",
          arguments: argumentsValue,
        },
      },
    }),
  ).toEqual({ rawName: "browser", qualifiedName: "bigbud_orchestration: browser" });
});

it("reads a native OpenCode envelope without changing its versioned tool identifier", () => {
  const payload = {
    data: {
      name: "bigbud_thread_v1_rename_thread",
      status: "completed",
      input: { title: "New title" },
    },
  };
  const original = JSON.stringify(payload);
  expect(readOwnedToolPresentation(payload)).toEqual({
    rawName: "bigbud_thread_v1_rename_thread",
    qualifiedName: "bigbud_thread_v1_rename_thread",
  });
  expect(JSON.stringify(payload)).toBe(original);
});
