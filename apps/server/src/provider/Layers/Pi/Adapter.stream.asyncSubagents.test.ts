import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ProviderRuntimeEvent, ThreadId } from "@bigbud/contracts";

import type { ActivePiSession, PiSyntheticEventFn } from "./Adapter.types.ts";
import { mapPiAsyncSubagentWidget } from "./Adapter.stream.asyncSubagents.ts";
import { handleExtensionUiRequest } from "./Adapter.stream.handlers.userInput.ts";

const threadId = "thread-pi-async" as ThreadId;
const session = {
  threadId,
  sessionEpoch: 3,
  activeTurnId: undefined,
} as ActivePiSession;

function snapshot(generatedAt: number, state: string, tool = "read") {
  return {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    generatedAt,
    caps: {
      maxRuns: 20,
      maxChildrenPerNode: 8,
      maxDepth: 3,
      maxStringLength: 160,
      maxSerializedBytes: 32768,
    },
    omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    runs: [
      {
        id: "workflow-1",
        kind: "workflow",
        label: "Parallel review",
        state,
        startedAt: 1790612435569,
        children: [
          {
            id: "architecture",
            kind: "step",
            label: "Architecture",
            state,
            startedAt: 1790612435608,
            activity: { currentTool: tool, lastActivityAt: generatedAt, toolCount: 2 },
          },
          {
            id: "security",
            kind: "step",
            label: "Security",
            state,
            startedAt: 1790612435659,
            activity: { currentTool: tool, lastActivityAt: generatedAt, toolCount: 3 },
          },
          { id: "quality", kind: "step", label: "Quality", state, startedAt: 1790612435682 },
          { id: "delivery", kind: "step", label: "Delivery", state, startedAt: 1790612435706 },
        ],
      },
    ],
  };
}

function widgetMessage(widgetKey: string, value: unknown) {
  return {
    type: "extension_ui_request",
    id: "widget",
    method: "setWidget",
    widgetKey,
    widgetLines: [`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify(value)}`],
  } as const;
}

describe("Pi async subagent status widget", () => {
  it("maps a detached workflow's child snapshot into visible agent tasks", async () => {
    const events: ProviderRuntimeEvent[] = [];
    const send = (data: unknown, widgetKey = "subagent-async") =>
      Effect.runPromise(
        handleExtensionUiRequest({
          emit: (batch) => Effect.sync(() => void events.push(...batch)),
          makeSyntheticEvent: (() => Effect.die("unexpected")) as PiSyntheticEventFn,
          runPromise: Effect.runPromise,
          session,
          sessions: new Map([[threadId, session]]),
          message: {
            type: "extension_ui_request",
            id: `widget-${events.length}`,
            method: "setWidget",
            widgetKey,
            widgetLines: [`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify(data)}`],
          },
        }),
      );

    await send(snapshot(1790612440000, "running"));
    expect(events).toHaveLength(4);
    expect(events).toMatchObject([
      {
        type: "task.updated",
        payload: {
          kind: "providerSubagent",
          nativeId: "workflow-1:architecture",
          subject: "Architecture",
          status: "inProgress",
          background: true,
          lastToolName: "read",
        },
      },
      {
        type: "task.updated",
        payload: { nativeId: "workflow-1:security", status: "inProgress" },
      },
      { type: "task.updated", payload: { nativeId: "workflow-1:quality" } },
      { type: "task.updated", payload: { nativeId: "workflow-1:delivery" } },
    ]);
    await send(snapshot(1790612440500, "running"));
    expect(events).toHaveLength(4);
    await send(snapshot(1790612441000, "complete", ""));
    expect(events.slice(4)).toMatchObject([
      {
        type: "task.updated",
        payload: { nativeId: "workflow-1:architecture", status: "completed" },
      },
      { type: "task.updated", payload: { nativeId: "workflow-1:security", status: "completed" } },
      { type: "task.updated", payload: { nativeId: "workflow-1:quality", status: "completed" } },
      { type: "task.updated", payload: { nativeId: "workflow-1:delivery", status: "completed" } },
    ]);
    await send(snapshot(1790612439000, "running"));
    await send(snapshot(1790612442000, "running"), "other-widget");
    expect(events).toHaveLength(8);
  });

  it("accepts terminal and clear snapshots that share the latest millisecond", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1790612440000);
    const isolated = { ...session } as ActivePiSession;
    expect(
      mapPiAsyncSubagentWidget(
        isolated,
        widgetMessage("subagent-async", snapshot(1790612440000, "running")),
      ),
    ).toHaveLength(4);
    expect(
      mapPiAsyncSubagentWidget(
        isolated,
        widgetMessage("subagent-async", snapshot(1790612440000, "complete")),
      ).filter((event) => event.type === "task.updated"),
    ).toHaveLength(4);
    expect(
      mapPiAsyncSubagentWidget(isolated, {
        ...widgetMessage("subagent-async", snapshot(1790612440000, "complete")),
        widgetLines: [],
      }).filter((event) => event.type === "task.removed"),
    ).toHaveLength(4);
    vi.useRealTimers();
  });

  it("removes omitted nodes, honors clears, and rejects snapshots older than a clear", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1790612450000);
    const isolated = { ...session } as ActivePiSession;
    expect(
      mapPiAsyncSubagentWidget(
        isolated,
        widgetMessage("subagent-async", snapshot(1790612440000, "running")),
      ),
    ).toHaveLength(4);
    const omitted = snapshot(1790612441000, "running");
    omitted.runs[0]!.children = omitted.runs[0]!.children.slice(0, 1);
    const omittedEvents = mapPiAsyncSubagentWidget(
      isolated,
      widgetMessage("subagent-async", omitted),
    );
    expect(omittedEvents.filter((event) => event.type === "task.removed")).toHaveLength(3);

    const cleared = mapPiAsyncSubagentWidget(isolated, {
      ...widgetMessage("subagent-async", omitted),
      widgetLines: [],
    });
    expect(cleared).toMatchObject([{ type: "task.removed" }]);
    expect(
      mapPiAsyncSubagentWidget(
        isolated,
        widgetMessage("subagent-async", snapshot(1790612442000, "running")),
      ),
    ).toEqual([]);
    vi.useRealTimers();
  });

  it("rejects unrelated widgets and malformed snapshots, and bounds child details", () => {
    const isolated = { ...session } as ActivePiSession;
    expect(
      mapPiAsyncSubagentWidget(isolated, widgetMessage("other-widget", snapshot(1000, "running"))),
    ).toEqual([]);
    expect(
      mapPiAsyncSubagentWidget(
        isolated,
        widgetMessage("subagent-async", { ...snapshot(1000, "running"), version: 2 }),
      ),
    ).toEqual([]);
    const data = snapshot(1790612440000, "running");
    const first = data.runs[0]!.children[0]!;
    if (!first.activity) throw new Error("Expected child activity");
    Object.assign(first.activity, { currentTool: "x".repeat(500), secret: "child transcript" });
    const events = mapPiAsyncSubagentWidget(isolated, widgetMessage("subagent-async", data));
    expect(events).toHaveLength(4);
    expect(JSON.stringify(events)).not.toContain("child transcript");
    expect(
      (events[0] as Extract<ProviderRuntimeEvent, { type: "task.updated" }>).payload.lastToolName,
    ).toHaveLength(120);
  });
});
