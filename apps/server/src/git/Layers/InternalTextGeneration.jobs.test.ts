import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import {
  MessageId,
  ProjectId,
  ThreadId,
  TextGenerationError,
  type OrchestrationCommand,
  type OrchestrationThread,
} from "@bigbud/contracts";
import { maybeGenerateThreadElevatorSummary } from "../../orchestration/Layers/ProviderCommandReactorHandlers.elevatorSummary.ts";
import type { SessionOpServices } from "../../orchestration/Layers/ProviderCommandReactorSessionOps.types.ts";

function fixture() {
  let thread = {
    id: ThreadId.makeUnsafe("fixture"),
    projectId: ProjectId.makeUnsafe("project"),
    title: "Keep this title",
    elevatorSummary: "Keep this summary",
    elevatorSummaryMessageCount: 0,
    modelSelection: { provider: "codex", model: "selected-but-unproven" },
    worktreePath: "/fixture",
    archivedAt: null,
    deletingAt: null,
    deletedAt: null,
    activities: [],
    messages: Array.from({ length: 5 }, (_, index) => ({
      id: MessageId.makeUnsafe(`message:${index}`),
      role: index % 2 ? "assistant" : "user",
      text: `Text ${index}`,
      turnId: null,
      streaming: false,
      createdAt: "2026-10-16T00:00:00.000Z",
      updatedAt: "2026-10-16T00:00:00.000Z",
    })),
  } as unknown as OrchestrationThread;
  const generate = vi.fn(
    () =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadElevatorSummary",
          detail: "Provider unavailable",
        }),
      ) as Effect.Effect<{ summary: string }, TextGenerationError>,
  );
  const dispatch = vi.fn((command: OrchestrationCommand) =>
    Effect.sync(() => {
      if (command.type === "thread.activity.append")
        thread = { ...thread, activities: [...thread.activities, command.activity] };
      if (command.type === "thread.meta.update" && command.elevatorSummary)
        thread = { ...thread, elevatorSummary: command.elevatorSummary };
      return { sequence: 1 };
    }),
  );
  const services = {
    resolveThread: () => Effect.succeed(thread),
    serverSettingsService: {
      getSettings: Effect.succeed({
        textGenerationModelSelection: { provider: "codex", model: "explicit-model" },
      }),
    },
    orchestrationEngine: { dispatch, getReadModel: () => Effect.succeed({ projects: [] }) },
    textGeneration: { generateThreadElevatorSummary: generate },
  } as unknown as SessionOpServices;
  return {
    get thread() {
      return thread;
    },
    generate,
    dispatch,
    run: maybeGenerateThreadElevatorSummary(services),
  };
}

describe("internal metadata generation jobs", () => {
  it("keeps existing content on failure and waits for explicit Retry instead of looping", async () => {
    const test = fixture();
    await Effect.runPromise(test.run({ threadId: test.thread.id }));
    await Effect.runPromise(test.run({ threadId: test.thread.id }));
    expect(test.generate).toHaveBeenCalledTimes(1);
    expect(test.thread.elevatorSummary).toBe("Keep this summary");
    expect(test.thread.title).toBe("Keep this title");
    expect(test.thread.activities.at(-1)?.kind).toBe("text-generation.failed");
    test.generate.mockReturnValue(Effect.succeed({ summary: "Recovered summary" }));
    await Effect.runPromise(test.run({ threadId: test.thread.id, force: true }));
    expect(test.generate).toHaveBeenCalledTimes(2);
    expect(test.thread.elevatorSummary).toBe("Recovered summary");
    expect(test.thread.activities.at(-1)?.kind).toBe("text-generation.completed");
  });
  it("does not convert cancellation into a warning or a retry", async () => {
    const test = fixture();
    test.generate.mockReturnValue(Effect.interrupt);
    await Effect.runPromiseExit(test.run({ threadId: test.thread.id }));
    expect(test.generate).toHaveBeenCalledTimes(1);
    expect(test.dispatch).not.toHaveBeenCalled();
    expect(test.thread.elevatorSummary).toBe("Keep this summary");
  });
});
