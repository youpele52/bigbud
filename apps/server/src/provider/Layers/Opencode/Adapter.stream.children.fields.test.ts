import { ThreadId, TurnId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import type { Event, Session } from "@opencode-ai/sdk/v2";
import { describe, expect, it } from "vitest";

import type { ActiveOpencodeSession } from "./Adapter.types.ts";
import { makeChildSessionTracker, tracksChildSessions } from "./Adapter.stream.children.ts";

type TaskEvent = Extract<ProviderRuntimeEvent, { type: "task.updated" }>;

const child = {
  id: "child-1",
  parentID: "parent-1",
  agent: "general",
  title: "Run the tests",
  time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
} as Session;

const session = {
  threadId: ThreadId.makeUnsafe("thread-1"),
  sessionEpoch: 2,
  activeTurnId: TurnId.makeUnsafe("turn-1"),
  opencodeSessionId: "parent-1",
  client: {
    session: {
      children: async ({ sessionID }: { sessionID: string }) => ({
        data: sessionID === "parent-1" ? [child] : [],
      }),
      status: async () => ({ data: { "child-1": { type: "busy" } } }),
    },
  },
} as unknown as ActiveOpencodeSession;

// Shapes follow @opencode-ai/sdk 1.17.13 v2 `AssistantMessage` and `ToolPart`.
const assistant = (id: string, input: number, output: number, cost: number) =>
  ({
    type: "message.updated",
    properties: {
      sessionID: "child-1",
      info: {
        id,
        role: "assistant",
        sessionID: "child-1",
        modelID: "claude-sonnet-4-5",
        providerID: "anthropic",
        cost,
        tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1_700_000_001_000 },
      },
    },
  }) as unknown as Event;

const toolPart = (status: "running" | "completed" | "error") =>
  ({
    type: "message.part.updated",
    properties: {
      sessionID: "child-1",
      part: {
        id: "part-1",
        sessionID: "child-1",
        messageID: "assistant-2",
        type: "tool",
        callID: "call-1",
        tool: "bash",
        state:
          status === "running"
            ? { status, input: {}, title: "bun run test", time: { start: 1 } }
            : status === "completed"
              ? {
                  status,
                  input: {},
                  output: "",
                  title: "bun run test",
                  metadata: {},
                  time: { start: 1, end: 2 },
                }
              : { status, input: {}, error: "exit 1", time: { start: 1, end: 2 } },
      },
    },
  }) as unknown as Event;

describe("OpenCode V1 and KiloCode child subagent fields", () => {
  it("is enabled by the subagent declaration for opencode and kilocode only", () => {
    expect(tracksChildSessions("opencode")).toBe(true);
    expect(tracksChildSessions("kilocode")).toBe(true);
    expect(tracksChildSessions("opencodeV2")).toBe(false);
    expect(tracksChildSessions("cursor")).toBe(false);
  });

  it("maps model, summed metrics, tool steps and end time under the adapter's provider", async () => {
    const tracker = makeChildSessionTracker(session, "kilocode");
    const [discovered] = (await tracker.refresh()) as TaskEvent[];
    expect(discovered).toMatchObject({
      provider: "kilocode",
      payload: { taskId: "kilocode:thread-1:2:child-1", kind: "providerSubagent" },
    });
    const [first] = (await tracker.handle(assistant("assistant-1", 100, 20, 0.01))) as TaskEvent[];
    expect(first?.payload).toMatchObject({
      model: "anthropic/claude-sonnet-4-5",
      metrics: { totalTokens: 120, costUsd: 0.01 },
    });
    const [second] = (await tracker.handle(assistant("assistant-2", 50, 10, 0.005))) as TaskEvent[];
    expect(second?.payload.metrics).toEqual({ totalTokens: 180, costUsd: 0.015 });
    // A repeated update of the same message replaces, never double counts.
    expect(await tracker.handle(assistant("assistant-2", 50, 10, 0.005))).toEqual([]);
    const [running] = (await tracker.handle(toolPart("running"))) as TaskEvent[];
    expect(running?.payload).toMatchObject({
      lastToolName: "bun run test",
      recentSteps: [{ id: "part-1", toolName: "bash", label: "bun run test", status: "running" }],
    });
    const [failed] = (await tracker.handle(toolPart("error"))) as TaskEvent[];
    expect(failed?.payload.recentSteps).toEqual([
      expect.objectContaining({ id: "part-1", status: "failed" }),
    ]);
    const [idle] = (await tracker.handle({
      type: "session.idle",
      properties: { sessionID: "child-1" },
    } as Event)) as TaskEvent[];
    expect(idle?.payload).toMatchObject({
      status: "completed",
      model: "anthropic/claude-sonnet-4-5",
    });
    expect(idle?.payload.endedAt).toBeDefined();
  });

  it("keeps the opencode identity by default", async () => {
    const tracker = makeChildSessionTracker(session);
    const [discovered] = (await tracker.refresh()) as TaskEvent[];
    expect(discovered?.provider).toBe("opencode");
    expect(discovered?.payload.taskId).toBe("opencode:thread-1:2:child-1");
    expect(discovered?.payload.model).toBeUndefined();
    expect(discovered?.payload.metrics).toBeUndefined();
  });
});
