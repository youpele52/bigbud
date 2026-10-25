import { assert, describe, it } from "@effect/vitest";
import { Effect, Random } from "effect";

import { makeDeterministicRandomService, makeHarness } from "./Adapter.test.helpers.ts";
import {
  SUBAGENT_FIXTURE_MESSAGES,
  fixtureInitialization,
  isTaskDone,
  latestTaskUpdates,
  replayClaudeMessages,
} from "./Adapter.stream.subagents.test.helpers.ts";

describe("Claude SDK 0.3.301 subagent fixture replay", () => {
  it.effect("shows foreground and background subagents with model, steps and metrics", () => {
    const harness = makeHarness();
    harness.query.setInitializationResponse(fixtureInitialization());
    return Effect.gen(function* () {
      const events = yield* replayClaudeMessages(
        harness,
        SUBAGENT_FIXTURE_MESSAGES,
        isTaskDone("task_bg"),
      );
      const tasks = latestTaskUpdates(events);
      const foreground = tasks.get("task_fg");
      assert.equal(foreground?.kind, "providerSubagent");
      assert.equal(foreground?.status, "completed");
      // The Agent tool input's model outranks the definition and the observed model.
      assert.equal(foreground?.model, "sonnet");
      assert.equal(foreground?.effort, "high");
      assert.equal(foreground?.prompt, "Review the reducer diff for bugs");
      assert.equal(foreground?.depth, 1);
      assert.equal(foreground?.subagentType, "code-reviewer");
      assert.equal(foreground?.resultSummary, "Found one bug in the reducer");
      assert.isDefined(foreground?.endedAt);
      assert.deepEqual(foreground?.metrics, { totalTokens: 15000, toolUses: 3, durationMs: 12000 });
      assert.deepEqual(
        foreground?.recentSteps?.map((step) => [step.id, step.toolName, step.status]),
        [["toolu_fg_read", "Read", "completed"]],
      );
      assert.equal(foreground?.lastToolName, "Bash");

      const background = tasks.get("task_bg");
      assert.equal(background?.kind, "providerSubagent");
      assert.equal(background?.background, true);
      // No input model: the agent definition's model applies.
      assert.equal(background?.model, "haiku");
      assert.deepEqual(background?.metrics, { totalTokens: 6000, toolUses: 2, durationMs: 5000 });
      assert.deepEqual(
        background?.recentSteps?.map((step) => [step.toolName, step.status]),
        [["Grep", "running"]],
      );
      assert.equal(background?.resultSummary, "Indexed 42 documents");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("never moves the context meter and keeps subagents out of the plan", () => {
    const harness = makeHarness();
    harness.query.setInitializationResponse(fixtureInitialization());
    return Effect.gen(function* () {
      const events = yield* replayClaudeMessages(
        harness,
        SUBAGENT_FIXTURE_MESSAGES,
        isTaskDone("task_bg"),
      );
      assert.equal(
        events.some((event) => event.type === "thread.token-usage.updated"),
        false,
      );
      const planSteps = new Set(
        events.flatMap((event) =>
          event.type === "turn.plan.updated" ? event.payload.plan.map((step) => step.step) : [],
        ),
      );
      assert.equal(planSteps.has("Review diff"), false);
      assert.equal(planSteps.has("Index docs"), false);
      assert.equal(planSteps.has("Run tests"), true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps ambient and shell tasks out of the Subagents card", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const events = yield* replayClaudeMessages(
        harness,
        SUBAGENT_FIXTURE_MESSAGES,
        isTaskDone("task_bg"),
      );
      const tasks = latestTaskUpdates(events);
      assert.equal(tasks.get("task_watch")?.kind, "task");
      assert.equal(tasks.get("task_shell")?.kind, "task");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("guards the parent's blocks from subagent partial messages", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const events = yield* replayClaudeMessages(
        harness,
        SUBAGENT_FIXTURE_MESSAGES,
        isTaskDone("task_bg"),
      );
      const serialized = JSON.stringify(events);
      assert.equal(serialized.includes("child partial must not reach the parent"), false);
      // The colliding index (1) still belongs to the parent's Agent tool, so its result and
      // input reached the foreground task instead of being lost to the child partial.
      assert.equal(latestTaskUpdates(events).get("task_fg")?.effort, "high");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps every CLIProxy task an ordinary task (D11)", () => {
    const harness = makeHarness({
      resolveHarness: () => Effect.succeed({ binaryPath: "claude" }),
    });
    return Effect.gen(function* () {
      const events = yield* replayClaudeMessages(
        harness,
        SUBAGENT_FIXTURE_MESSAGES,
        (event) =>
          event.type === "task.updated" &&
          event.payload.nativeId === "task_bg" &&
          event.payload.status === "completed",
      );
      const tasks = latestTaskUpdates(events);
      for (const id of ["task_fg", "task_bg"]) {
        assert.equal(tasks.get(id)?.kind, "task");
        assert.isUndefined(tasks.get(id)?.recentSteps);
        assert.isUndefined(tasks.get(id)?.model);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});
