import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { updateClaudeTaskPlan } from "../../provider/Layers/Claude/Adapter.stream.tasks.ts";
import { makeClaudeTaskState } from "../../provider/Layers/Claude/Adapter.tasks.types.ts";
import type { ClaudeSessionContext } from "../../provider/Layers/Claude/Adapter.types.ts";
import { mapPiAsyncSubagentWidget } from "../../provider/Layers/Pi/Adapter.stream.asyncSubagents.ts";
import type { ActivePiSession } from "../../provider/Layers/Pi/Adapter.types.ts";
import {
  asEventId,
  asThreadId,
  createHarness,
  registerProviderRuntimeIngestionTestCleanup,
} from "./ProviderRuntimeIngestion.test.helpers.ts";

type Harness = Awaited<ReturnType<typeof createHarness>>;
const persistedTasks = async (harness: Harness) =>
  (await harness.getPersistedSnapshot()).threads.find((thread) => thread.id === "thread-1")?.tasks;

async function expectRemoved(harness: Harness) {
  await harness.drain();
  expect(await persistedTasks(harness)).toEqual([]);
  const model = await Effect.runPromise(harness.engine.getReadModel());
  expect(model.threads.find((thread) => thread.id === "thread-1")?.tasks).toEqual([]);
}

const message = (generatedAt: number, runs: object[]) => ({
  type: "extension_ui_request" as const,
  id: "widget",
  method: "setWidget" as const,
  widgetKey: "subagent-async",
  widgetLines: [
    `PI_SUBAGENT_ASYNC_JSON:${JSON.stringify({ kind: "pi-subagents.async-status-snapshot", version: 1, generatedAt, runs })}`,
  ],
});

describe("Provider subagent snapshot removal identity", () => {
  registerProviderRuntimeIngestionTestCleanup();

  for (const kind of ["providerSubagent", "task"] as const) {
    it.each(["background_tasks_changed", "TaskList", "TaskUpdate"])(
      `removes a persisted Claude ${kind} through actual %s events`,
      async (toolName) => {
        const harness = await createHarness({ provider: "claudeAgent" });
        const context = {
          session: { threadId: asThreadId("thread-1") },
          sessionEpoch: 0,
          taskState: makeClaudeTaskState(),
          modernTaskExposure: true,
          providerSubagentsSupported: true,
        } as ClaudeSessionContext;
        const at = Date.now();
        let eventOrdinal = 0;
        const removals: Array<Extract<ProviderRuntimeEvent, { type: "task.removed" }>> = [];
        const apply = (input: Record<string, unknown>, offset: number) => {
          const now = new Date(at + offset).toISOString();
          return Effect.runPromise(
            updateClaudeTaskPlan({
              context,
              toolUseId: `tool-${offset}`,
              toolName,
              input,
              authoritativeSnapshot: toolName === "TaskList",
              now,
              makeEventStamp: () =>
                Effect.succeed({
                  eventId: asEventId(`event-${eventOrdinal++}`),
                  createdAt: now,
                }),
              offerRuntimeEvent: (session, event) =>
                Effect.sync(() => {
                  const stamped = { ...event, sessionEpoch: session.sessionEpoch };
                  if (stamped.type === "task.removed") removals.push(stamped);
                  else harness.emit(stamped);
                }),
            }),
          );
        };
        const task = {
          task_id: "child",
          task_type: kind === "providerSubagent" ? "local_agent" : "local_bash",
          status: "running",
          description: "Review",
        };
        await apply(toolName === "TaskUpdate" ? task : { tasks: [task] }, 0);
        await harness.drain();
        expect(await persistedTasks(harness)).toMatchObject([
          {
            id: kind === "providerSubagent" ? "thread-1:0:child" : "child",
            kind,
            status: "inProgress",
            freshness: { providerTimestamp: new Date(at).toISOString() },
          },
        ]);
        const progress = { ...task, description: "Reviewing" };
        await apply(toolName === "TaskUpdate" ? progress : { tasks: [progress] }, 1);
        await harness.drain();
        await apply(
          toolName === "TaskUpdate" ? { task_id: "child", status: "deleted" } : { tasks: [] },
          2,
        );
        expect(context.taskState.tasks.size).toBe(0);
        expect(removals).toHaveLength(1);
        const removal = removals[0]!;
        harness.emit({
          ...removal,
          eventId: asEventId("stale-removal"),
          payload: {
            ...removal.payload,
            freshness: {
              ...removal.payload.freshness,
              providerTimestamp: new Date(at - 1).toISOString(),
            },
          },
        });
        await harness.drain();
        expect(await persistedTasks(harness)).toHaveLength(1);
        harness.emit(removal);
        await expectRemoved(harness);
        // A later boundary must not resurrect throttled progress from before removal.
        harness.emit({
          type: "session.state.changed",
          eventId: asEventId("claude-flush"),
          provider: "claudeAgent",
          threadId: context.session.threadId,
          sessionEpoch: 0,
          createdAt: new Date(at + 3).toISOString(),
          payload: { state: "ready", reason: "test boundary" },
        });
        await expectRemoved(harness);
      },
    );
  }

  it("removes actual Pi widget nodes, including throttled progress", async () => {
    const harness = await createHarness({ provider: "pi" });
    const session = { threadId: asThreadId("thread-1"), sessionEpoch: 0 } as ActivePiSession;
    const at = Date.now();
    for (const event of mapPiAsyncSubagentWidget(
      session,
      message(at, [{ id: "child", kind: "subagent", label: "Review", state: "running" }]),
    ))
      harness.emit(event);
    await harness.drain();
    expect(await persistedTasks(harness)).toMatchObject([
      { id: "thread-1:0:child", kind: "providerSubagent", status: "inProgress" },
    ]);
    for (const event of mapPiAsyncSubagentWidget(
      session,
      message(at + 1, [{ id: "child", kind: "subagent", label: "Reviewing", state: "running" }]),
    ))
      harness.emit(event);
    await harness.drain();
    const removals = mapPiAsyncSubagentWidget(session, message(at + 2, []));
    for (const event of removals) {
      if (event.type !== "task.removed") throw new Error("Expected removal");
      harness.emit({
        ...event,
        eventId: asEventId(`stale-${event.eventId}`),
        payload: {
          ...event.payload,
          freshness: { ...event.payload.freshness, providerRevision: at - 1 },
        },
      });
    }
    await harness.drain();
    // A stale removal must not discard the newer throttled snapshot.
    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("flush"),
      provider: "pi",
      threadId: session.threadId,
      sessionEpoch: 0,
      createdAt: new Date().toISOString(),
      payload: { state: "ready", reason: "test boundary" },
    });
    await harness.drain();
    expect(await persistedTasks(harness)).toMatchObject([{ subject: "Reviewing" }]);
    for (const event of removals) harness.emit(event);
    await expectRemoved(harness);
  });
});
