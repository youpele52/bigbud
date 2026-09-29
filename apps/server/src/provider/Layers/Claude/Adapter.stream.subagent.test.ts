import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, it, assert } from "@effect/vitest";
import { Effect, Fiber, Random, Stream } from "effect";

import { ClaudeAdapter } from "../../Services/Claude/Adapter.ts";
import { THREAD_ID, makeDeterministicRandomService, makeHarness } from "./Adapter.test.helpers.ts";

describe("ClaudeAdapterLive forwarded subagent text", () => {
  it.effect("associates forwarded text with a verified agent task", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) => event.type === "tool.progress" && event.payload.summary === "Reviewed files",
        ),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "delegate", attachments: [] });
      const base = { type: "system", session_id: "sdk-session-subagent" };
      harness.query.emit({
        ...base,
        subtype: "task_started",
        uuid: "task-start-1",
        task_id: "task-1",
        tool_use_id: "task-tool-1",
        description: "Review files",
      } as unknown as SDKMessage);
      harness.query.emit({
        ...base,
        subtype: "background_tasks_changed",
        uuid: "task-snapshot-1",
        tasks: [{ task_id: "task-1", task_type: "agent", description: "Review files" }],
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-subagent",
        uuid: "assistant-child-1",
        parent_tool_use_id: "task-tool-1",
        subagent_type: "code-reviewer",
        message: {
          id: "assistant-child-message-1",
          content: [{ type: "text", text: "Reviewed files" }],
        },
      } as unknown as SDKMessage);
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const update = events.find(
        (event) =>
          event.type === "task.updated" && event.payload.progressSummary === "Reviewed files",
      );
      assert.equal(update?.type, "task.updated");
      if (update?.type === "task.updated") assert.equal(update.payload.kind, "providerSubagent");
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("projects forwarded assistant text as nested tool progress", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "tool.progress"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "delegate", attachments: [] });

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-subagent",
        uuid: "assistant-subagent-1",
        parent_tool_use_id: "task-tool-1",
        subagent_type: "code-reviewer",
        message: {
          id: "assistant-subagent-message-1",
          content: [{ type: "text", text: "Subagent inspected the changed files." }],
        },
      } as unknown as SDKMessage);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const progress = events.find((event) => event.type === "tool.progress");
      assert.equal(progress?.type, "tool.progress");
      if (progress?.type === "tool.progress") {
        assert.equal(progress.payload.toolUseId, "task-tool-1");
        assert.equal(progress.payload.toolName, "code-reviewer");
        assert.equal(progress.payload.summary, "Subagent inspected the changed files.");
      }
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});
