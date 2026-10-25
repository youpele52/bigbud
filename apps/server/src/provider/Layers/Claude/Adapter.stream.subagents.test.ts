import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Random } from "effect";

import { makeDeterministicRandomService, makeHarness } from "./Adapter.test.helpers.ts";
import {
  isTaskDone,
  latestTaskUpdates,
  replayClaudeMessages,
} from "./Adapter.stream.subagents.test.helpers.ts";

const session = { session_id: "sdk-session-sub" };
const started = (overrides: Record<string, unknown> = {}) =>
  ({
    type: "system",
    subtype: "task_started",
    ...session,
    uuid: `start-${String(overrides.run_id ?? "1")}`,
    task_id: "task-a",
    tool_use_id: "toolu-a",
    description: "Survey",
    task_type: "local_agent",
    ...overrides,
  }) as unknown as SDKMessage;
const notification = (overrides: Record<string, unknown> = {}) =>
  ({
    type: "system",
    subtype: "task_notification",
    ...session,
    uuid: `note-${String(overrides.uuid ?? overrides.run_id ?? "1")}`,
    task_id: "task-a",
    status: "completed",
    output_file: "/tmp/out",
    summary: "Done",
    ...overrides,
  }) as unknown as SDKMessage;
const childAssistant = (index: number, overrides: Record<string, unknown> = {}) =>
  ({
    type: "assistant",
    ...session,
    uuid: `child-${index}`,
    parent_tool_use_id: "toolu-other",
    agent_id: "task-a",
    message: {
      id: `msg-${index}`,
      model: "claude-opus-4-1",
      content: [{ type: "tool_use", id: `tool-${index}`, name: "Read", input: {} }],
    },
    ...overrides,
  }) as unknown as SDKMessage;

const run = (
  messages: ReadonlyArray<SDKMessage>,
  until: Parameters<typeof replayClaudeMessages>[2],
  harness = makeHarness(),
) =>
  replayClaudeMessages(harness, messages, until).pipe(
    Effect.map(latestTaskUpdates),
    Effect.provideService(Random.Random, makeDeterministicRandomService()),
    Effect.provide(harness.layer),
  );

describe("Claude provider subagent frames", () => {
  it.effect("correlates by agent_id and bounds the step ring at five", () =>
    Effect.gen(function* () {
      const children = Array.from({ length: 7 }, (_, index) => childAssistant(index));
      const tasks = yield* run([started(), ...children, notification()], isTaskDone("task-a"));
      const agent = tasks.get("task-a");
      assert.equal(agent?.kind, "providerSubagent");
      assert.equal(agent?.model, "claude-opus-4-1");
      assert.deepEqual(
        agent?.recentSteps?.map((step) => step.id),
        ["tool-2", "tool-3", "tool-4", "tool-5", "tool-6"],
      );
    }),
  );

  it.effect("keeps subagent text out of the summary unless forwarding is on", () =>
    Effect.gen(function* () {
      const text = (uuid: string) =>
        childAssistant(0, {
          uuid,
          message: { id: uuid, content: [{ type: "text", text: "Reading the reducer" }] },
        });
      const off = yield* run([started(), text("t-off"), notification()], isTaskDone("task-a"));
      assert.isUndefined(off.get("task-a")?.progressSummary);
      const on = yield* run(
        [started(), text("t-on"), notification()],
        isTaskDone("task-a"),
        makeHarness({
          serverSettings: {
            providers: { claudeAgent: { rollout: { forwardedSubagentText: true } } },
          },
        }),
      );
      assert.equal(on.get("task-a")?.progressSummary, "Reading the reducer");
    }),
  );

  it.effect("ignores late runs and reopens the task for a newer run", () =>
    Effect.gen(function* () {
      const tasks = yield* run(
        [
          started({ run_id: "run-2" }),
          notification({ run_id: "run-1", status: "failed", summary: "Late failure" }),
          notification({ run_id: "run-2", summary: "First run done" }),
          started({ run_id: "run-3", uuid: "start-3" }),
          notification({ run_id: "run-3", uuid: "note-3", summary: "Second run done" }),
        ],
        (event) =>
          event.type === "task.updated" && event.payload.resultSummary === "Second run done",
      );
      const agent = tasks.get("task-a");
      assert.equal(agent?.status, "completed");
      assert.equal(agent?.resultSummary, "Second run done");
    }),
  );

  it.effect("clears the previous result while a newer run is active", () =>
    Effect.gen(function* () {
      const tasks = yield* run(
        [
          started({ run_id: "run-1" }),
          notification({ run_id: "run-1", summary: "First run done" }),
          started({ run_id: "run-2", uuid: "start-2" }),
        ],
        (() => {
          let completed = false;
          return (event) => {
            if (event.type !== "task.updated" || event.payload.nativeId !== "task-a") return false;
            if (event.payload.status === "completed") completed = true;
            return completed && event.payload.status === "inProgress";
          };
        })(),
      );
      const agent = tasks.get("task-a");
      assert.equal(agent?.status, "inProgress");
      assert.isUndefined(agent?.endedAt);
      assert.isUndefined(agent?.resultSummary);
    }),
  );

  it.effect("maps a worker restart to stopped with a reason", () =>
    Effect.gen(function* () {
      const tasks = yield* run(
        [started(), notification({ status: "stopped", reason: "worker_restart" })],
        (event) => event.type === "task.updated" && event.payload.status === "stopped",
      );
      assert.equal(tasks.get("task-a")?.terminalReason, "worker restarted");
    }),
  );

  it.effect("names the current tool from a subagent tool_progress heartbeat", () =>
    Effect.gen(function* () {
      const heartbeat = {
        type: "tool_progress",
        ...session,
        uuid: "heartbeat-1",
        tool_use_id: "toolu-bash",
        tool_name: "Bash",
        parent_tool_use_id: null,
        elapsed_time_seconds: 4,
        task_id: "task-a",
      } as unknown as SDKMessage;
      const tasks = yield* run(
        [started(), heartbeat],
        (event) => event.type === "task.updated" && event.payload.lastToolName === "Bash",
      );
      assert.equal(tasks.get("task-a")?.activityFresh, true);
    }),
  );

  it.effect("still classifies the legacy synthetic agent task type", () =>
    Effect.gen(function* () {
      const tasks = yield* run(
        [started({ task_type: "agent" }), notification()],
        isTaskDone("task-a"),
      );
      assert.equal(tasks.get("task-a")?.kind, "providerSubagent");
    }),
  );

  it.effect("turns task progress usage into metrics, never thread token usage", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const events = yield* replayClaudeMessages(
        harness,
        [
          {
            type: "system",
            subtype: "task_progress",
            ...session,
            uuid: "task-usage-progress-1",
            task_id: "task-usage-1",
            description: "Thinking through the patch",
            usage: { total_tokens: 321, tool_uses: 2, duration_ms: 654 },
          } as unknown as SDKMessage,
        ],
        (event) => event.type === "task.progress",
      ).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
      assert.equal(
        events.some((event) => event.type === "thread.token-usage.updated"),
        false,
      );
      assert.equal(
        events.some((event) => event.type === "task.progress"),
        true,
      );
      const update = events.find((event) => event.type === "task.updated");
      if (update?.type === "task.updated") {
        assert.deepEqual(update.payload.metrics, {
          totalTokens: 321,
          toolUses: 2,
          durationMs: 654,
        });
      }
    }),
  );
});
