import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Random, Stream } from "effect";

import { ClaudeAdapter } from "../../Services/Claude/Adapter.ts";
import { PROVIDER_SUBAGENT_CAPABILITIES } from "../../providerSubagents.capabilities.ts";
import { makeDeterministicRandomService, makeHarness, THREAD_ID } from "./Adapter.test.helpers.ts";

const started = (taskId: string, taskType: string) =>
  ({
    type: "system",
    subtype: "task_started",
    session_id: "sdk-session-stop",
    uuid: `start-${taskId}`,
    task_id: taskId,
    tool_use_id: `toolu-${taskId}`,
    description: `Run ${taskId}`,
    task_type: taskType,
  }) as unknown as SDKMessage;

const completed = (taskId: string) =>
  ({
    type: "system",
    subtype: "task_notification",
    session_id: "sdk-session-stop",
    uuid: `note-${taskId}`,
    task_id: taskId,
    status: "completed",
    output_file: "/tmp/out",
    summary: "Done",
  }) as unknown as SDKMessage;

const taskSeen = (nativeId: string, status: string) => (event: ProviderRuntimeEvent) =>
  event.type === "task.updated" &&
  event.payload.nativeId === nativeId &&
  event.payload.status === status;

/** Starts a turn, emits `messages`, waits for `until`, then tries to stop `nativeTaskId`. */
const stopAfter = (
  messages: ReadonlyArray<SDKMessage>,
  until: (event: ProviderRuntimeEvent) => boolean,
  nativeTaskId: string,
) => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const adapter = yield* ClaudeAdapter;
    const seen = yield* adapter.streamEvents.pipe(
      Stream.filter(until),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkChild,
    );
    yield* adapter.startSession({
      threadId: THREAD_ID,
      provider: "claudeAgent",
      runtimeMode: "full-access",
    });
    yield* adapter.sendTurn({ threadId: THREAD_ID, input: "delegate", attachments: [] });
    for (const message of messages) harness.query.emit(message);
    yield* Fiber.join(seen);
    const stopSubagent = adapter.stopSubagent;
    assert.isDefined(stopSubagent);
    const result = yield* Effect.result(stopSubagent(THREAD_ID, nativeTaskId));
    yield* adapter.stopSession(THREAD_ID);
    return { result, calls: [...harness.query.stopTaskCalls] };
  }).pipe(
    Effect.provideService(Random.Random, makeDeterministicRandomService()),
    Effect.provide(harness.layer),
  );
};

describe("Claude per-subagent Stop", () => {
  it("declares per-subagent Stop for Claude only", () => {
    assert.equal(PROVIDER_SUBAGENT_CAPABILITIES.claudeAgent.stop, true);
    assert.notEqual(PROVIDER_SUBAGENT_CAPABILITIES.cliProxy.stop, true);
  });

  it.effect("calls stopTask for a running provider subagent", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* stopAfter(
        [started("task-a", "local_agent")],
        taskSeen("task-a", "inProgress"),
        "task-a",
      );
      assert.equal(result._tag, "Success");
      assert.deepEqual(calls, ["task-a"]);
    }),
  );

  it.effect("rejects unknown tasks without calling stopTask", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* stopAfter(
        [started("task-a", "local_agent")],
        taskSeen("task-a", "inProgress"),
        "task-missing",
      );
      assert.equal(result._tag, "Failure");
      assert.deepEqual(calls, []);
    }),
  );

  it.effect("rejects ordinary tasks such as shell commands", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* stopAfter(
        [started("task-sh", "local_bash")],
        taskSeen("task-sh", "inProgress"),
        "task-sh",
      );
      assert.equal(result._tag, "Failure");
      assert.deepEqual(calls, []);
    }),
  );

  it.effect("rejects subagents that already finished", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* stopAfter(
        [started("task-a", "local_agent"), completed("task-a")],
        taskSeen("task-a", "completed"),
        "task-a",
      );
      assert.equal(result._tag, "Failure");
      assert.deepEqual(calls, []);
    }),
  );
});
