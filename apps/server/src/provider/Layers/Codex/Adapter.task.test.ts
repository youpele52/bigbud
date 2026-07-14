import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, it } from "@effect/vitest";

import { Effect, Fiber, Layer, Stream } from "effect";

import type { ProviderEvent } from "@bigbud/contracts";

import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { CodexAdapter } from "../../Services/Codex/Adapter.ts";
import { makeCodexAdapterLive } from "./Adapter.ts";
import {
  FakeCodexManager,
  asEventId,
  asItemId,
  asThreadId,
  asTurnId,
  providerSessionDirectoryTestLayer,
} from "./Adapter.test.helpers.ts";

const taskManager = new FakeCodexManager();
const taskLayer = it.layer(
  makeCodexAdapterLive({ manager: taskManager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

taskLayer("CodexAdapterLive task events", (it) => {
  it.effect("maps Codex task and reasoning event chunks into canonical runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
        Effect.forkChild,
      );

      taskManager.emit("event", {
        id: asEventId("evt-codex-task-started"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "codex/event/task_started",
        payload: {
          id: "turn-structured-1",
          msg: {
            type: "task_started",
            turn_id: "turn-structured-1",
            collaboration_mode_kind: "plan",
          },
        },
      } satisfies ProviderEvent);

      taskManager.emit("event", {
        id: asEventId("evt-codex-agent-reasoning"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "codex/event/agent_reasoning",
        payload: {
          id: "turn-structured-1",
          msg: {
            type: "agent_reasoning",
            text: "Need to compare both transport layers before finalizing the plan.",
          },
        },
      } satisfies ProviderEvent);

      taskManager.emit("event", {
        id: asEventId("evt-codex-reasoning-delta"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "codex/event/reasoning_content_delta",
        payload: {
          id: "turn-structured-1",
          msg: {
            type: "reasoning_content_delta",
            turn_id: "turn-structured-1",
            item_id: "rs_reasoning_1",
            delta: "**Compare** transport boundaries",
            summary_index: 0,
          },
        },
      } satisfies ProviderEvent);

      taskManager.emit("event", {
        id: asEventId("evt-codex-task-complete"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "codex/event/task_complete",
        payload: {
          id: "turn-structured-1",
          msg: {
            type: "task_complete",
            turn_id: "turn-structured-1",
            last_agent_message: "<proposed_plan>\n# Ship it\n</proposed_plan>",
          },
        },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));

      assert.equal(events[0]?.type, "task.started");
      if (events[0]?.type === "task.started") {
        assert.equal(events[0].turnId, "turn-structured-1");
        assert.equal(events[0].payload.taskId, "turn-structured-1");
        assert.equal(events[0].payload.taskType, "plan");
      }

      assert.equal(events[1]?.type, "task.progress");
      if (events[1]?.type === "task.progress") {
        assert.equal(events[1].payload.taskId, "turn-structured-1");
        assert.equal(
          events[1].payload.description,
          "Need to compare both transport layers before finalizing the plan.",
        );
      }

      assert.equal(events[2]?.type, "content.delta");
      if (events[2]?.type === "content.delta") {
        assert.equal(events[2].turnId, "turn-structured-1");
        assert.equal(events[2].itemId, "rs_reasoning_1");
        assert.equal(events[2].payload.streamKind, "reasoning_summary_text");
        assert.equal(events[2].payload.summaryIndex, 0);
      }

      assert.equal(events[3]?.type, "task.completed");
      if (events[3]?.type === "task.completed") {
        assert.equal(events[3].turnId, "turn-structured-1");
        assert.equal(events[3].payload.taskId, "turn-structured-1");
        assert.equal(events[3].payload.summary, "<proposed_plan>\n# Ship it\n</proposed_plan>");
      }

      assert.equal(events[4]?.type, "turn.proposed.completed");
      if (events[4]?.type === "turn.proposed.completed") {
        assert.equal(events[4].turnId, "turn-structured-1");
        assert.equal(events[4].payload.planMarkdown, "# Ship it");
      }
    }),
  );

  it.effect("prefers manager-assigned turn ids for Codex task events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      taskManager.emit("event", {
        id: asEventId("evt-codex-task-started-parent-turn"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-parent"),
        createdAt: new Date().toISOString(),
        method: "codex/event/task_started",
        payload: {
          id: "turn-child",
          msg: {
            type: "task_started",
            turn_id: "turn-child",
            collaboration_mode_kind: "default",
          },
          conversationId: "child-provider-thread",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "task.started");
      if (firstEvent.value.type !== "task.started") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-parent");
      assert.equal(firstEvent.value.providerRefs?.providerTurnId, "turn-parent");
      assert.equal(firstEvent.value.payload.taskId, "turn-child");
    }),
  );

  it.effect("unwraps Codex token usage payloads for context window events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      taskManager.emit("event", {
        id: asEventId("evt-codex-thread-token-usage-updated"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: new Date().toISOString(),
        method: "thread/tokenUsage/updated",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              inputTokens: 11_833,
              cachedInputTokens: 3456,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 11_839,
            },
            last: {
              inputTokens: 120,
              cachedInputTokens: 0,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 126,
            },
            modelContextWindow: 258_400,
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "thread.token-usage.updated");
      if (firstEvent.value.type !== "thread.token-usage.updated") {
        return;
      }

      assert.deepEqual(firstEvent.value.payload.usage, {
        usedTokens: 126,
        totalProcessedTokens: 11_839,
        maxTokens: 258_400,
        inputTokens: 120,
        cachedInputTokens: 0,
        outputTokens: 6,
        reasoningOutputTokens: 0,
        lastUsedTokens: 126,
        lastInputTokens: 120,
        lastCachedInputTokens: 0,
        lastOutputTokens: 6,
        lastReasoningOutputTokens: 0,
        compactsAutomatically: true,
      });
      assert.deepEqual(firstEvent.value.payload.accounting, {
        scope: "turn",
        scopeId: "turn-1",
        processedTokens: 126,
        inputTokens: 120,
        cachedInputTokens: 0,
        outputTokens: 6,
        reasoningOutputTokens: 0,
        finalized: true,
      });
    }),
  );

  it.effect("maps refreshed Codex protocol notification names", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* Stream.take(adapter.streamEvents, 2).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      taskManager.emit("event", {
        id: asEventId("evt-codex-patch-updated"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("item-1"),
        createdAt: new Date().toISOString(),
        method: "item/fileChange/patchUpdated",
        payload: { item: { type: "fileChange", id: "item-1", path: "README.md" } },
      } satisfies ProviderEvent);
      taskManager.emit("event", {
        id: asEventId("evt-codex-realtime-transcript"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "thread/realtime/transcript/delta",
        payload: { delta: "hello" },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(events[0]?.type, "item.updated");
      assert.equal(events[1]?.type, "thread.realtime.item-added");
      if (events[1]?.type === "thread.realtime.item-added") {
        assert.deepEqual(events[1].payload.item, { delta: "hello" });
      }
    }),
  );
});

afterAll(() => {
  if (taskManager.stopAllImpl.mock.calls.length === 0) {
    taskManager.stopAll();
  }
  assert.ok(taskManager.stopAllImpl.mock.calls.length >= 1);
});
