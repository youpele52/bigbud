import { EventId, ThreadId, TurnId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { ActivePiSession } from "./Adapter.types.ts";
import { mapPiSubagentResults } from "./Adapter.stream.subagents.ts";
import { handleToolExecutionEnd } from "./Adapter.stream.handlers.ts";

const session = {
  threadId: ThreadId.makeUnsafe("thread-1"),
  sessionEpoch: 2,
  activeTurnId: TurnId.makeUnsafe("turn-1"),
} as ActivePiSession;
const result = (agent: string, task: string, exitCode: number) => ({
  agent,
  task,
  exitCode,
  messages: [{ role: "assistant", content: [{ type: "text", text: "working" }] }],
});

describe("Pi extension subagent mapping", () => {
  it("keeps parallel interim exitCode zero active and isolates messages", () => {
    const events = mapPiSubagentResults({
      session,
      toolCallId: "call-1",
      toolName: "subagent",
      final: false,
      createdAt: "2026-09-28T00:00:00.000Z",
      result: {
        details: {
          mode: "parallel",
          results: [
            { ...result("reviewer", "Review", 0), usage: { input: 12, output: 3, secret: "omit" } },
            result("coder", "Code", -1),
          ],
        },
      },
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "task.updated",
      payload: { activeLabel: "parallel mode" },
    });
    expect(
      events.map((event) => (event.type === "task.updated" ? event.payload.status : "")),
    ).toEqual(["inProgress", "inProgress"]);
    expect(JSON.stringify(events)).not.toContain('"messages"');
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(events[0]).toMatchObject({
      type: "task.updated",
      payload: { usage: { input: 12, output: 3 } },
    });
  });

  it("marks chain steps terminal only on final result", () => {
    const events = mapPiSubagentResults({
      session,
      toolCallId: "call-2",
      toolName: "subagent",
      final: true,
      createdAt: "2026-09-28T00:00:01.000Z",
      result: {
        details: {
          mode: "chain",
          results: [result("researcher", "Find", 0), result("writer", "Write", 1)],
        },
      },
    });
    expect(
      events.map((event) => (event.type === "task.updated" ? event.payload.status : "")),
    ).toEqual(["completed", "failed"]);
    expect(
      mapPiSubagentResults({
        session,
        toolCallId: "call-2",
        toolName: "subagent",
        final: false,
        createdAt: "2026-09-28T00:00:02.000Z",
        result: { details: { mode: "chain", results: [result("researcher", "Find", 0)] } },
      }),
    ).toEqual([]);
  });

  it("rejects arbitrary tools and malformed details", () => {
    const base = {
      session,
      toolCallId: "call-3",
      final: false,
      createdAt: "2026-09-28T00:00:00.000Z",
    };
    expect(
      mapPiSubagentResults({
        ...base,
        toolName: "my_agent",
        result: { details: { mode: "single", results: [result("x", "y", 0)] } },
      }),
    ).toEqual([]);
    expect(
      mapPiSubagentResults({
        ...base,
        toolName: "subagent",
        result: { details: { mode: "single", results: [{ agent: "x" }] } },
      }),
    ).toEqual([]);
  });

  it("keeps final child messages out of the parent tool item", async () => {
    const emitted: ProviderRuntimeEvent[] = [];
    const live = {
      ...session,
      turns: [],
      currentToolInfoById: new Map([
        [
          "call-4",
          {
            toolName: "subagent",
            args: undefined,
            itemType: "dynamic_tool_call",
            title: "Tool call",
          },
        ],
      ]),
      currentToolOutputById: new Map(),
    } as ActivePiSession;
    await Effect.runPromise(
      handleToolExecutionEnd({
        emit: (events) =>
          Effect.sync(() => {
            emitted.push(...events);
          }),
        session: live,
        stamp: { eventId: EventId.makeUnsafe("event-1"), createdAt: "2026-09-28T00:00:00.000Z" },
        raw: { source: "pi.rpc.event", payload: { details: { secret: "child transcript" } } },
        message: {
          toolCallId: "call-4",
          result: { details: { mode: "single", results: [result("reviewer", "Review", 0)] } },
        },
      }),
    );
    expect(emitted.some((event) => event.type === "item.completed")).toBe(true);
    expect(JSON.stringify(emitted)).not.toContain('"messages"');
    expect(JSON.stringify(emitted)).not.toContain("child transcript");
  });
});
