import { EventId, ThreadId, TurnId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import type { SessionEvent } from "@github/copilot-sdk";
import { describe, expect, it } from "vitest";

import { mapCopilotSubagentEvent } from "./Adapter.mapEvent.subagents.ts";
import type { ActiveCopilotSession } from "./Adapter.types.ts";

type TaskEvent = Extract<ProviderRuntimeEvent, { type: "task.updated" }>;

const makeSession = () =>
  ({
    threadId: ThreadId.makeUnsafe("thread-1"),
    sessionEpoch: 3,
    activeTurnId: TurnId.makeUnsafe("turn-1"),
  }) as ActiveCopilotSession;

// Shapes follow @github/copilot-sdk 1.0.7 `generated/session-events.d.ts`.
const envelope = (second: number, agentId: string | null = "agent-1") => ({
  id: `evt-${second}`,
  parentId: null,
  ...(agentId ? { agentId } : {}),
  timestamp: `2026-10-16T00:00:${String(second).padStart(2, "0")}.000Z`,
});

function map(session: ActiveCopilotSession, event: object): TaskEvent[] {
  return (mapCopilotSubagentEvent(
    session,
    event as SessionEvent,
    EventId.makeUnsafe(`id-${JSON.stringify(event).length}`),
  ) ?? []) as TaskEvent[];
}

const started = {
  ...envelope(1),
  type: "subagent.started",
  data: {
    agentName: "explore",
    agentDisplayName: "Explore",
    agentDescription: "Searches the codebase",
    model: "claude-sonnet-4.5",
    toolCallId: "call-1",
  },
};

describe("Copilot provider subagent mapping", () => {
  it("maps the model at start, steps from agentId tool events, and metrics at completion", () => {
    const session = makeSession();
    const [start] = map(session, started);
    expect(start?.payload).toMatchObject({
      taskId: "copilot:thread-1:3:call-1",
      kind: "providerSubagent",
      status: "inProgress",
      subject: "Explore",
      subagentType: "explore",
      model: "claude-sonnet-4.5",
      agentId: "agent-1",
    });
    const [step] = map(session, {
      ...envelope(2),
      type: "tool.execution_start",
      data: { toolCallId: "child-tool-1", toolName: "grep", arguments: { pattern: "TODO" } },
    });
    expect(step?.payload).toMatchObject({
      status: "inProgress",
      lastToolName: "grep",
      model: "claude-sonnet-4.5",
      recentSteps: [{ id: "child-tool-1", toolName: "grep", status: "running" }],
    });
    const [done] = map(session, {
      ...envelope(3),
      type: "tool.execution_complete",
      data: { toolCallId: "child-tool-1", success: false },
    });
    expect(done?.payload.recentSteps).toEqual([
      expect.objectContaining({ id: "child-tool-1", status: "failed" }),
    ]);
    const [completed] = map(session, {
      ...envelope(4),
      type: "subagent.completed",
      data: {
        agentName: "explore",
        agentDisplayName: "Explore",
        toolCallId: "call-1",
        model: "claude-sonnet-4.5",
        totalTokens: 1200,
        totalToolCalls: 4,
        durationMs: 3000,
      },
    });
    expect(completed?.payload).toMatchObject({
      status: "completed",
      metrics: { totalTokens: 1200, toolUses: 4, durationMs: 3000 },
      endedAt: "2026-10-16T00:00:04.000Z",
      recentSteps: [expect.objectContaining({ id: "child-tool-1" })],
    });
    // A terminal subagent ignores late child tool events.
    expect(
      map(session, {
        ...envelope(5),
        type: "tool.execution_start",
        data: { toolCallId: "late", toolName: "view" },
      }),
    ).toEqual([]);
  });

  it("maps a failure with its reason and end time, and never invents absent data", () => {
    const session = makeSession();
    const [start] = map(session, {
      ...started,
      data: { ...started.data, model: undefined },
    });
    expect(start?.payload.model).toBeUndefined();
    expect(start?.payload.metrics).toBeUndefined();
    expect(start?.payload.endedAt).toBeUndefined();
    const [failed] = map(session, {
      ...envelope(6),
      type: "subagent.failed",
      data: {
        agentName: "explore",
        agentDisplayName: "Explore",
        toolCallId: "call-1",
        error: "Rate limited",
      },
    });
    expect(failed?.payload).toMatchObject({
      status: "failed",
      terminalReason: "Rate limited",
      endedAt: "2026-10-16T00:00:06.000Z",
    });
    expect(failed?.payload.metrics).toBeUndefined();
  });

  it("ignores tool completion for an unknown step and events without an agent", () => {
    const session = makeSession();
    map(session, started);
    expect(
      map(session, {
        ...envelope(7),
        type: "tool.execution_complete",
        data: { toolCallId: "never-started", success: true },
      }),
    ).toEqual([]);
    expect(
      mapCopilotSubagentEvent(
        session,
        {
          ...envelope(8, null),
          type: "tool.execution_start",
          data: { toolCallId: "root-tool", toolName: "view" },
        } as SessionEvent,
        EventId.makeUnsafe("root"),
      ),
    ).toBeUndefined();
  });
});
