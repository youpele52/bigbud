import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, it, assert } from "@effect/vitest";
import { Effect, Fiber, Random, Stream } from "effect";

import { ClaudeAdapter } from "../../Services/Claude/Adapter.ts";
import { THREAD_ID, makeDeterministicRandomService, makeHarness } from "./Adapter.test.helpers.ts";

function taskToolMessage(input: {
  readonly index: number;
  readonly toolId: string;
  readonly toolName: "TaskCreate" | "TaskUpdate" | "TaskList";
  readonly value: Record<string, unknown>;
  readonly sequence: number;
}): ReadonlyArray<SDKMessage> {
  const common = {
    type: "stream_event",
    session_id: "sdk-session-modern-plan",
    parent_tool_use_id: null,
  } as const;
  return [
    {
      ...common,
      uuid: `modern-plan-start-${input.sequence}`,
      event: {
        type: "content_block_start",
        index: input.index,
        content_block: { type: "tool_use", id: input.toolId, name: input.toolName, input: {} },
      },
    },
    {
      ...common,
      uuid: `modern-plan-input-${input.sequence}`,
      event: {
        type: "content_block_delta",
        index: input.index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(input.value) },
      },
    },
    {
      ...common,
      uuid: `modern-plan-stop-${input.sequence}`,
      event: { type: "content_block_stop", index: input.index },
    },
  ] as unknown as ReadonlyArray<SDKMessage>;
}

function modernPlanPayloads(
  events: ReadonlyArray<{ readonly type: string; readonly payload: unknown }>,
) {
  return events.flatMap((event) => (event.type === "turn.plan.updated" ? [event.payload] : []));
}

describe("ClaudeAdapterLive modern task plans", () => {
  const trace = (executionTargetId?: string) => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "turn.plan.updated" &&
            event.payload.plan.some((step) => step.status === "completed"),
        ),
        Stream.runCollect,
        Effect.forkChild,
      );
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        ...(executionTargetId ? { executionTargetId, cwd: "/srv/project" } : {}),
      });
      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan work",
        attachments: [],
      });

      for (const message of [
        ...taskToolMessage({
          index: 0,
          toolId: "task-create",
          toolName: "TaskCreate",
          value: { task_id: "task-1", subject: "Inspect files", status: "pending" },
          sequence: 1,
        }),
        ...taskToolMessage({
          index: 1,
          toolId: "task-update",
          toolName: "TaskUpdate",
          value: { taskId: "task-1", statusChange: { to: "in_progress" } },
          sequence: 2,
        }),
        ...taskToolMessage({
          index: 2,
          toolId: "task-list",
          toolName: "TaskList",
          value: {},
          sequence: 3,
        }),
      ]) {
        harness.query.emit(message);
      }
      harness.query.emit({
        type: "user",
        uuid: "modern-plan-task-list-result",
        session_id: "sdk-session-modern-plan",
        parent_tool_use_id: null,
        tool_use_result: {
          tasks: [{ id: "task-1", subject: "Inspect files", status: "completed", blockedBy: [] }],
        },
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "task-list", content: "Task list returned" },
          ],
        },
      } as unknown as SDKMessage);
      const events = Array.from(yield* Fiber.join(runtimeEventsFiber));
      yield* adapter.stopSession(THREAD_ID);
      return { events, turnId: turn.turnId };
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  };

  it.effect(
    "projects local TaskCreate, TaskUpdate, and TaskList through the shared plan event",
    () =>
      trace().pipe(
        Effect.tap(({ events, turnId }) =>
          Effect.sync(() => {
            const plans = modernPlanPayloads(events);
            assert.deepEqual(plans, [
              { plan: [{ step: "Inspect files", status: "pending" }] },
              { plan: [{ step: "Inspect files", status: "inProgress" }] },
              { plan: [{ step: "Inspect files", status: "completed" }] },
            ]);
            const taskItems = events.filter(
              (event) => event.type === "item.started" || event.type === "item.updated",
            );
            assert.equal(
              taskItems.every((event) =>
                event.type !== "item.started" && event.type !== "item.updated"
                  ? true
                  : event.payload.itemType !== "file_change",
              ),
              true,
            );
            assert.equal(
              events
                .filter((event) => event.type === "turn.plan.updated")
                .every((event) => String(event.turnId) === String(turnId)),
              true,
            );
          }),
        ),
      ),
  );

  it.effect("reconciles a native background task notification into a completed plan", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "turn.plan.updated" &&
            event.payload.plan.some((step) => step.status === "completed"),
        ),
        Stream.runCollect,
        Effect.forkChild,
      );
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "run background task",
        attachments: [],
      });

      harness.query.emit({
        type: "system",
        subtype: "background_tasks_changed",
        uuid: "background-snapshot-1",
        session_id: "sdk-session-native-task",
        tasks: [{ task_id: "task-1", task_type: "agent", description: "Background task" }],
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        uuid: "task-notification-1",
        session_id: "sdk-session-native-task",
        task_id: "task-1",
        status: "completed",
        summary: "Background task complete",
      } as unknown as SDKMessage);

      const events = Array.from(yield* Fiber.join(runtimeEventsFiber));
      yield* adapter.stopSession(THREAD_ID);
      assert.equal(
        events.some((event) => event.type === "task.completed"),
        true,
      );
      assert.deepEqual(
        events.filter((event) => event.type === "turn.plan.updated").at(-1)?.payload,
        { plan: [{ step: "Background task", status: "completed" }] },
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("projects the identical modern task plan through a remote Claude bridge", () =>
    trace("ssh:host=devbox&user=root&port=22").pipe(
      Effect.tap(({ events, turnId }) =>
        Effect.sync(() => {
          assert.deepEqual(modernPlanPayloads(events), [
            { plan: [{ step: "Inspect files", status: "pending" }] },
            { plan: [{ step: "Inspect files", status: "inProgress" }] },
            { plan: [{ step: "Inspect files", status: "completed" }] },
          ]);
          assert.equal(
            events
              .filter((event) => event.type === "turn.plan.updated")
              .every((event) => String(event.turnId) === String(turnId)),
            true,
          );
        }),
      ),
    ),
  );
});
