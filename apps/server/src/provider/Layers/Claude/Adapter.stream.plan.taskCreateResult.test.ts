import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Random, Stream } from "effect";

import { ClaudeAdapter } from "../../Services/Claude/Adapter.ts";
import { makeDeterministicRandomService, makeHarness, THREAD_ID } from "./Adapter.test.helpers.ts";

function toolMessage(input: {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly value: Record<string, unknown>;
}): ReadonlyArray<SDKMessage> {
  const common = {
    type: "stream_event",
    session_id: "sdk-session-task-result",
    parent_tool_use_id: null,
  } as const;
  return [
    {
      ...common,
      uuid: `${input.id}-start`,
      event: {
        type: "content_block_start",
        index: input.index,
        content_block: { type: "tool_use", id: input.id, name: input.name, input: {} },
      },
    },
    {
      ...common,
      uuid: `${input.id}-input`,
      event: {
        type: "content_block_delta",
        index: input.index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(input.value) },
      },
    },
    {
      ...common,
      uuid: `${input.id}-stop`,
      event: { type: "content_block_stop", index: input.index },
    },
  ] as unknown as ReadonlyArray<SDKMessage>;
}

describe("Claude task creation result correlation", () => {
  it.effect("promotes an ID-less TaskCreate before applying its TaskUpdate", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "turn.plan.updated" &&
            event.payload.plan.some((step) => step.status === "completed"),
        ),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "track work", attachments: [] });

      for (const message of toolMessage({
        index: 0,
        id: "create-tool",
        name: "TaskCreate",
        value: { subject: "Inspect files", description: "Review files" },
      })) {
        harness.query.emit(message);
      }
      harness.query.emit({
        type: "user",
        uuid: "task-create-result",
        session_id: "sdk-session-task-result",
        parent_tool_use_id: null,
        tool_use_result: { task: { id: "1", subject: "Inspect files" } },
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "create-tool",
              content: "Task created",
            },
          ],
        },
      } as unknown as SDKMessage);
      for (const message of toolMessage({
        index: 1,
        id: "update-tool",
        name: "TaskUpdate",
        value: { taskId: "1", status: "completed" },
      })) {
        harness.query.emit(message);
      }

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const plans = events.flatMap((event) =>
        event.type === "turn.plan.updated" ? [event.payload] : [],
      );
      assert.deepEqual(plans.at(-1), {
        plan: [{ step: "Inspect files", status: "completed" }],
      });
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not project ordinary tool descriptions as tasks", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "inspect files", attachments: [] });
      for (const message of toolMessage({
        index: 0,
        id: "bash-tool",
        name: "Bash",
        value: { description: "Inventory Desktop files by size", command: "ls" },
      })) {
        harness.query.emit(message);
      }
      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.isFalse(events.some((event) => event.type === "turn.plan.updated"));
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("removes a provisional task when TaskCreate fails", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) => event.type === "turn.plan.updated" && event.payload.plan.length === 0,
        ),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "track work", attachments: [] });
      for (const message of toolMessage({
        index: 0,
        id: "failed-create-tool",
        name: "TaskCreate",
        value: { subject: "Task that failed", description: "Cannot be created" },
      })) {
        harness.query.emit(message);
      }
      harness.query.emit({
        type: "user",
        uuid: "failed-task-create-result",
        session_id: "sdk-session-task-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "failed-create-tool",
              content: "Task creation failed",
              is_error: true,
            },
          ],
        },
      } as unknown as SDKMessage);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const plans = events.flatMap((event) =>
        event.type === "turn.plan.updated" ? [event.payload] : [],
      );
      assert.deepEqual(plans, [
        { plan: [{ step: "Task that failed", status: "pending" }] },
        { plan: [] },
      ]);
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});
