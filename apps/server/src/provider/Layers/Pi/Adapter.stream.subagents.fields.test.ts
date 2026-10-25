import { ThreadId, TurnId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import type { ActivePiSession } from "./Adapter.types.ts";
import { mapPiAsyncSubagentWidget } from "./Adapter.stream.asyncSubagents.ts";
import { mapPiSubagentResults } from "./Adapter.stream.subagents.ts";

type TaskEvent = Extract<ProviderRuntimeEvent, { type: "task.updated" }>;
const tasks = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.filter((event): event is TaskEvent => event.type === "task.updated");

const makeSession = () =>
  ({
    threadId: ThreadId.makeUnsafe("thread-pi"),
    sessionEpoch: 4,
    activeTurnId: TurnId.makeUnsafe("turn-1"),
  }) as ActivePiSession;

// Shapes follow the Pi 0.80.3 subagent extension `details.results` and pi-ai messages
// (`ToolCall` content parts and `toolResult` messages).
const result = {
  agent: "scout",
  task: "Find every TODO in src",
  exitCode: 0,
  model: "anthropic/claude-haiku-4-5",
  usage: { input: 100, output: 20, cacheRead: 5, cost: 0.012 },
  messages: [
    {
      role: "assistant",
      content: [
        { type: "text", text: "Searching" },
        { type: "toolCall", id: "tc-1", name: "grep", arguments: { pattern: "TODO" } },
      ],
    },
    { role: "toolResult", toolCallId: "tc-1", toolName: "grep", isError: false, content: [] },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc-2", name: "read", arguments: { path: "a.ts" } }],
    },
    { role: "toolResult", toolCallId: "tc-2", toolName: "read", isError: true, content: [] },
    { role: "assistant", content: [{ type: "text", text: "Found 3 TODOs" }] },
  ],
};

describe("Pi foreground subagent fields", () => {
  it("maps model, prompt, steps and metrics while running", () => {
    const [task] = tasks(
      mapPiSubagentResults({
        session: makeSession(),
        toolCallId: "call-1",
        toolName: "subagent",
        final: false,
        createdAt: "2026-10-16T00:00:01.000Z",
        result: { details: { mode: "single", results: [result] } },
      }),
    );
    expect(task?.payload).toMatchObject({
      kind: "providerSubagent",
      status: "inProgress",
      model: "anthropic/claude-haiku-4-5",
      prompt: "Find every TODO in src",
      lastToolName: "read",
      metrics: { totalTokens: 120, costUsd: 0.012 },
      recentSteps: [
        { id: "tc-1", toolName: "grep", status: "completed" },
        { id: "tc-2", toolName: "read", status: "failed" },
      ],
      progressSummary: "Found 3 TODOs",
    });
    expect(task?.payload.endedAt).toBeUndefined();
    expect(task?.payload.resultSummary).toBeUndefined();
  });

  it("sets the result summary and end time on the final event", () => {
    const [task] = tasks(
      mapPiSubagentResults({
        session: makeSession(),
        toolCallId: "call-2",
        toolName: "subagent",
        final: true,
        createdAt: "2026-10-16T00:00:09.000Z",
        result: { details: { mode: "single", results: [result] } },
      }),
    );
    expect(task?.payload).toMatchObject({
      status: "completed",
      resultSummary: "Found 3 TODOs",
      endedAt: "2026-10-16T00:00:09.000Z",
    });
  });

  it("leaves absent model and usage absent", () => {
    const [task] = tasks(
      mapPiSubagentResults({
        session: makeSession(),
        toolCallId: "call-3",
        toolName: "subagent",
        final: false,
        createdAt: "2026-10-16T00:00:01.000Z",
        result: { details: { mode: "single", results: [{ agent: "a", task: "b", exitCode: 0 }] } },
      }),
    );
    expect(task?.payload.model).toBeUndefined();
    expect(task?.payload.metrics).toBeUndefined();
    expect(task?.payload.recentSteps).toBeUndefined();
  });
});

function widget(generatedAt: number, state: string, currentTool?: string, toolCount?: number) {
  const value = {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    generatedAt,
    runs: [
      {
        id: "agent-1",
        kind: "subagent",
        label: "Indexer",
        state,
        startedAt: 1_790_000_000_000,
        updatedAt: generatedAt,
        activity: {
          ...(currentTool ? { currentTool } : {}),
          ...(toolCount !== undefined ? { toolCount } : {}),
        },
      },
    ],
  };
  return {
    type: "extension_ui_request",
    id: "widget",
    method: "setWidget",
    widgetKey: "subagent-async",
    widgetLines: [`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify(value)}`],
  } as const;
}

describe("Pi async subagent fields", () => {
  it("maps tool count to metrics and current tools to a step ring", () => {
    const session = makeSession();
    const first = tasks(
      mapPiAsyncSubagentWidget(session, widget(1_790_000_001_000, "running", "grep", 1)),
    );
    expect(first[0]?.payload).toMatchObject({
      status: "inProgress",
      background: true,
      metrics: { toolUses: 1 },
      recentSteps: [{ toolName: "grep", status: "running" }],
    });
    const second = tasks(
      mapPiAsyncSubagentWidget(session, widget(1_790_000_002_000, "running", "read", 2)),
    );
    expect(second[0]?.payload.recentSteps?.map((step) => [step.toolName, step.status])).toEqual([
      ["grep", "completed"],
      ["read", "running"],
    ]);
    const done = tasks(
      mapPiAsyncSubagentWidget(session, widget(1_790_000_003_000, "complete", "read", 2)),
    );
    expect(done[0]?.payload).toMatchObject({
      status: "completed",
      endedAt: new Date(1_790_000_003_000).toISOString(),
      metrics: { toolUses: 2 },
    });
    expect(done[0]?.payload.recentSteps?.map((step) => step.status)).toEqual([
      "completed",
      "completed",
    ]);
  });
});
