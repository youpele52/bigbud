import { CommandId, MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vitest";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  setup,
  threadId,
} from "../orchestration/Layers/OrchestrationEngine.metadataGeneration.test-helpers.ts";
import {
  createRuntime,
  withDatabase,
} from "../orchestration/Layers/OrchestrationEngine.test.runtime.ts";
import { initialTime } from "../orchestration/Layers/ThreadMetadataGeneration.coordinator.test-helpers.ts";
import { setElevatorSummaryViaOrchestration } from "./ThreadOrchestrationTools.summary.ts";
import { decodeSetElevatorSummaryArguments } from "./threadSummaryTool.shared.ts";

const invocation = {
  invocationId: "summary-call",
  sourceMessageId: MessageId.makeUnsafe("source"),
};

it("accepts only summary arguments, never a cross-thread target", () => {
  expect(decodeSetElevatorSummaryArguments({ summary: "Purpose" })).toEqual({ summary: "Purpose" });
  for (const value of [{ summary: "Purpose", targetThreadId: "other" }, { summary: 1 }, {}])
    expect(() => decodeSetElevatorSummaryArguments(value)).toThrow();
});

it.each(["missing", "deleted", "deleting"])(
  "refuses a %s caller without dispatch",
  async (state) => {
    const dispatch = vi.fn(() => Effect.succeed({ sequence: 1 }));
    const engine = {
      dispatch,
      getReadModel: () =>
        Effect.succeed({
          threads:
            state === "missing"
              ? []
              : [
                  {
                    id: threadId,
                    deletedAt: state === "deleted" ? initialTime : null,
                    deletingAt: state === "deleting" ? initialTime : null,
                  },
                ],
        }),
    } as unknown as OrchestrationEngineShape;
    await expect(
      Effect.runPromise(
        setElevatorSummaryViaOrchestration({
          orchestrationEngine: engine,
          threadId,
          summary: "Purpose",
          ...invocation,
        }),
      ),
    ).rejects.toThrow(/not found|being deleted/);
    expect(dispatch).not.toHaveBeenCalled();
  },
);

it("normalizes explicit summaries, replays the original frontier, rejects conflicts and fences stale automatic output", () =>
  withDatabase("bigbud-explicit-summary-", async (dbPath) => {
    const runtime = createRuntime(dbPath);
    try {
      const f = await setup(runtime, "summary");
      const write = (summary: string, invocationId = invocation.invocationId) =>
        runtime.runPromise(
          setElevatorSummaryViaOrchestration({
            orchestrationEngine: f.engine,
            threadId,
            summary,
            ...invocation,
            invocationId,
          }),
        );
      const accepted = await write('  "Explicit   outcome"\nignored second line');
      expect(accepted.summary).toBe("Explicit outcome");
      expect(
        (await runtime.runPromise(f.repository.readMetadataState(threadId))).summaryRevision,
      ).toBe(1);
      let thread = await runtime.runPromise(f.engine.ensureThreadState!(threadId, "history"));
      expect(thread).toMatchObject({
        elevatorSummary: "Explicit outcome",
        elevatorSummaryMessageCount: 1,
      });
      await runtime.runPromise(
        f.engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.makeUnsafe("later-message"),
          threadId,
          messageId: MessageId.makeUnsafe("later-message"),
          text: "Later work",
          createdAt: initialTime,
        }),
      );
      const sequence = (await runtime.runPromise(f.engine.getReadModel())).snapshotSequence;
      expect(await write("Explicit outcome")).toEqual(accepted);
      expect((await runtime.runPromise(f.engine.getReadModel())).snapshotSequence).toBe(sequence);
      await expect(write("Changed payload")).rejects.toThrow("payload digest does not match");
      await runtime.runPromise(f.engine.dispatch(f.command, f.options));
      expect((await runtime.runPromise(f.repository.listAttempts(f.job.jobId)))[0]?.state).toBe(
        "stale",
      );
      thread = await runtime.runPromise(f.engine.ensureThreadState!(threadId, "history"));
      expect(thread).toMatchObject({
        elevatorSummary: "Explicit outcome",
        elevatorSummaryMessageCount: 1,
      });
      const long = await write("x".repeat(200), "long-summary");
      expect(long.summary).toBe("x".repeat(147) + "...");
      expect(
        (await runtime.runPromise(f.engine.ensureThreadState!(threadId, "history")))
          ?.elevatorSummaryMessageCount,
      ).toBe(2);
      for (const summary of [" ", '""'])
        await expect(write(summary, "empty")).rejects.toThrow("cannot be empty");
      await expect(
        runtime.runPromise(
          setElevatorSummaryViaOrchestration({
            orchestrationEngine: f.engine,
            threadId: ThreadId.makeUnsafe("other"),
            summary: "No authority",
            ...invocation,
          }),
        ),
      ).rejects.toThrow("not found");
      for (const identity of [{ invocationId: " " }, { sourceMessageId: " " as MessageId }])
        await expect(
          runtime.runPromise(
            setElevatorSummaryViaOrchestration({
              orchestrationEngine: f.engine,
              threadId,
              summary: "Purpose",
              ...invocation,
              ...identity,
            }),
          ),
        ).rejects.toThrow("required");
    } finally {
      await runtime.dispose();
    }
  }));
