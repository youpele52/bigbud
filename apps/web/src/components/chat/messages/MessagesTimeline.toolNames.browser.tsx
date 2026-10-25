import "../../../index.css";

import {
  EventId,
  RuntimeTaskId,
  type OrchestrationTask,
  type OrchestrationThreadActivity,
} from "@bigbud/contracts";
import { deriveWorkLogEntries } from "../../../logic/session/worklog.logic";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SubagentRowDetails } from "../agents/SubagentRow.details";
import { subagentActivityLine } from "../agents/subagentPresentation.logic";
import { SimpleWorkEntryRow } from "./MessagesTimeline.workEntry";

const mocks = vi.hoisted(() => ({ copy: vi.fn(() => Promise.resolve()) }));
vi.mock("~/lib/clipboard/copyText", () => ({ copyTextToClipboard: mocks.copy }));

afterEach(() => {
  document.body.innerHTML = "";
  mocks.copy.mockClear();
});

it("renders bigbud renamer while copying the untouched provider identifier and preserving raw activity", async () => {
  const raw = "bigbud_thread_v1_rename_thread";
  const activity: OrchestrationThreadActivity = {
    id: EventId.makeUnsafe("rename-tool"),
    kind: "tool.completed",
    tone: "tool",
    turnId: null,
    summary: "Tool completed",
    createdAt: "2026-10-17T12:00:00Z",
    payload: {
      title: raw,
      detail: "Thread renamed",
      itemType: "dynamic_tool_call",
      data: { toolName: raw, input: { title: "Readable title" } },
    },
  };
  const original = JSON.stringify(activity);
  const entry = deriveWorkLogEntries([activity], undefined)[0]!;
  await render(<SimpleWorkEntryRow workEntry={entry} />);
  await expect.element(page.getByText("bigbud renamer", { exact: true })).toBeVisible();
  await expect
    .element(page.getByText("bigbud renamer", { exact: true }))
    .toHaveAttribute("title", raw);
  await page.getByRole("button", { name: "Copy message" }).click();
  expect(mocks.copy).toHaveBeenCalledExactlyOnceWith(`${raw}\nThread renamed`);
  expect(entry.toolTitle).toBe(raw);
  expect(JSON.stringify(activity)).toBe(original);
});

it("uses the same friendly name for subagent activity, steps and latest-tool details", async () => {
  const raw = "mcp__bigbud_orchestration__rename_thread";
  const agent: OrchestrationTask = {
    id: RuntimeTaskId.makeUnsafe("agent"),
    kind: "providerSubagent",
    nativeId: "agent",
    activityFresh: true,
    status: "inProgress",
    subject: "Agent",
    source: "observed",
    freshness: { sessionEpoch: "1", sourcePriority: 1, observedOrdinal: 1 },
    createdAt: "2026-10-17T12:00:00Z",
    updatedAt: "2026-10-17T12:00:00Z",
    lastToolName: raw,
    recentSteps: [{ toolName: raw, status: "completed", at: "2026-10-17T12:00:00Z" }],
  };
  const original = JSON.stringify(agent);
  const screen = await render(
    <>
      <p>{subagentActivityLine(agent)}</p>
      <SubagentRowDetails agent={agent} id="agent-details" />
    </>,
  );
  await expect.element(page.getByText("Running bigbud renamer", { exact: true })).toBeVisible();
  await expect
    .element(page.getByText("bigbud renamer", { exact: true }))
    .toHaveAttribute("title", raw);
  await screen.rerender(
    <SubagentRowDetails agent={{ ...agent, recentSteps: [] }} id="agent-details" />,
  );
  await expect
    .element(page.getByRole("region", { name: "Latest tool" }))
    .toHaveTextContent("Latest toolbigbud renamer");
  await expect
    .element(page.getByText("bigbud renamer", { exact: true }))
    .toHaveAttribute("title", raw);
  expect(JSON.stringify(agent)).toBe(original);
});

it.each([
  {
    summary: "bigbud_orchestration: browser",
    data: undefined,
    expected: "bigbud browser",
    raw: "bigbud_orchestration: browser",
  },
  {
    summary: "Tool call",
    data: { toolName: "mcp__bigbud_orchestration__browser", input: { action: "navigate" } },
    expected: "bigbud · navigating browser",
    raw: "mcp__bigbud_orchestration__browser",
  },
  {
    summary: "Tool call",
    data: {
      item: {
        type: "dynamicToolCall",
        namespace: "bigbud_orchestration",
        tool: "browser",
        arguments: '{"action":"capture"}',
      },
    },
    expected: "bigbud · captured browser",
    raw: "browser",
  },
  {
    summary: "Tool call",
    data: {
      type: "tool",
      tool: "bigbud_orchestration_thread-1_browser",
      state: { input: { action: "get_page_text" } },
    },
    expected: "bigbud · reading page text",
    raw: "bigbud_orchestration_thread-1_browser",
  },
  {
    summary: "mcp__bigbud_orchestration__computer_use",
    data: undefined,
    expected: "bigbud computer controller",
    raw: "mcp__bigbud_orchestration__computer_use",
  },
])(
  "renders owned browser/computer variants with raw inspection and copy: $expected",
  async ({ summary, data, expected, raw }) => {
    const activity: OrchestrationThreadActivity = {
      id: EventId.makeUnsafe("browser-display"),
      kind: "tool.updated",
      tone: "tool",
      turnId: null,
      summary,
      createdAt: "2026-10-17T12:00:00Z",
      payload: { itemType: "mcp_tool_call", ...(data ? { data } : {}) },
    };
    const original = JSON.stringify(activity);
    const entry = deriveWorkLogEntries([activity], undefined)[0]!;
    await render(<SimpleWorkEntryRow workEntry={entry} />);
    await expect.element(page.getByText(expected, { exact: true })).toBeVisible();
    await expect.element(page.getByText(expected, { exact: true })).toHaveAttribute("title", raw);
    await page.getByRole("button", { name: "Copy message" }).click();
    expect(mocks.copy).toHaveBeenCalledExactlyOnceWith(raw);
    expect(JSON.stringify(activity)).toBe(original);
  },
);

it("does not relabel another MCP server's browser or infer ownership from prose", async () => {
  const activity: OrchestrationThreadActivity = {
    id: EventId.makeUnsafe("external-browser"),
    kind: "tool.updated",
    tone: "tool",
    turnId: null,
    summary: "External browser call",
    createdAt: "2026-10-17T12:00:00Z",
    payload: {
      itemType: "mcp_tool_call",
      data: {
        item: {
          type: "mcpToolCall",
          server: "other",
          tool: "browser",
          arguments: { action: "navigate" },
        },
      },
    },
  };
  await render(<SimpleWorkEntryRow workEntry={deriveWorkLogEntries([activity], undefined)[0]!} />);
  await expect.element(page.getByText("External browser call", { exact: true })).toBeVisible();
  expect(document.body.textContent).not.toContain("bigbud");
});
