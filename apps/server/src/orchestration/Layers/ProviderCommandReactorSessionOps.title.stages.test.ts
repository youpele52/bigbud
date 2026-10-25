import { describe, expect, it, afterEach, vi } from "vitest";
import { TextGenerationError } from "@bigbud/contracts";
import { Deferred, Effect } from "effect";
import { titleFixture } from "./ProviderCommandReactorSessionOps.title.fixture.ts";
import {
  isThreadTitleLocked,
  lockThreadTitle,
  resetThreadTitleLockForTests,
} from "../../orchestration-tools/ThreadTitleLock.ts";
import { canonicalRenameThreadCommandId } from "../../orchestration-tools/ThreadOrchestrationTools.rename.ts";
import {
  readTitleStage,
  recordTitleStage,
} from "./ProviderCommandReactorSessionOps.title.state.ts";

describe("staged automatic thread titles", () => {
  afterEach(resetThreadTitleLockForTests);
  it("uses nonempty bounded context and the real scoped rename once after an oversized assistant response", async () => {
    const f = titleFixture();
    await Effect.runPromise(f.run());
    f.addSuccess(1);
    f.addSuccess(2);
    f.addSuccess(3, "verified-third");
    f.appendAssistant("A".repeat(8_001));
    f.generate
      .mockReturnValueOnce(
        Effect.fail(
          new TextGenerationError({ operation: "generateThreadTitle", detail: "Third failed" }),
        ),
      )
      .mockReturnValueOnce(Effect.succeed({ title: "Contextual reconnect recovery" }));
    await Effect.runPromise(f.run());
    expect(f.generate).toHaveBeenCalledTimes(4);
    expect(f.generate.mock.calls[3]?.[0]).toMatchObject({
      verifiedThreadModelOnly: true,
      modelSelection: { provider: "claudeAgent", model: "verified-third" },
      successfulModelSelection: { provider: "claudeAgent", model: "verified-third" },
      message: expect.stringContaining("Context from user 3"),
    });
    expect(
      f.dispatch.mock.calls.filter(([command]) => command.type === "thread.meta.update"),
    ).toHaveLength(1);
    expect(f.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.meta.update",
        commandId: canonicalRenameThreadCommandId({
          threadId: f.thread.id,
          sourceMessageId: f.thread.messages[0]!.id,
          invocationId: "automatic-title-context-fallback",
        }),
      }),
    );
    expect(f.thread.title).toBe("Contextual reconnect recovery");
    expect(isThreadTitleLocked(f.thread.id)).toBe(true);
    await Effect.runPromise(f.run());
    expect(f.generate).toHaveBeenCalledTimes(4);
  });
  it("runs two normal jobs then waits for three distinct successful user turns, including restart", async () => {
    const f = titleFixture();
    await Effect.runPromise(f.run());
    expect(f.generate).toHaveBeenCalledTimes(2);
    expect(f.thread.activities.some((activity) => activity.kind === "text-generation.failed")).toBe(
      false,
    );
    f.addSuccess(1);
    await Effect.runPromise(f.run());
    f.addSuccess(2);
    await Effect.runPromise(f.run());
    expect(f.generate).toHaveBeenCalledTimes(2);
    f.addSuccess(3, "verified-third");
    f.generate.mockReturnValueOnce(Effect.succeed({ title: "Recovered third-turn title" }));
    await Effect.runPromise(f.run());
    expect(f.generate).toHaveBeenCalledTimes(3);
    expect(f.generate.mock.calls[2]?.[0]).toMatchObject({
      verifiedThreadModelOnly: true,
      modelSelection: { provider: "claudeAgent", model: "verified-third" },
      successfulModelSelection: { provider: "claudeAgent", model: "verified-third" },
    });
    await Effect.runPromise(f.run());
    expect(f.generate).toHaveBeenCalledTimes(3);
    expect(f.thread.title).toBe("Recovered third-turn title");
  });
  it("uses the real scoped rename tool handler with same-model conversation context only after attempt three fails", async () => {
    const f = titleFixture();
    await Effect.runPromise(f.run());
    f.addSuccess(1);
    f.addSuccess(2);
    f.addSuccess(3, "verified-third");
    f.generate
      .mockReturnValueOnce(
        Effect.fail(
          new TextGenerationError({ operation: "generateThreadTitle", detail: "Third failed" }),
        ),
      )
      .mockReturnValueOnce(Effect.succeed({ title: "Contextual reconnect investigation" }));
    await Effect.runPromise(f.run());
    expect(f.generate).toHaveBeenCalledTimes(4);
    expect(f.generate.mock.calls[3]?.[0]).toMatchObject({
      verifiedThreadModelOnly: true,
      modelSelection: { provider: "claudeAgent", model: "verified-third" },
      message: expect.stringContaining("Context from user 3"),
    });
    expect(f.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.meta.update",
        commandId: canonicalRenameThreadCommandId({
          threadId: f.thread.id,
          sourceMessageId: f.thread.messages[0]!.id,
          invocationId: "automatic-title-context-fallback",
        }),
      }),
    );
    expect(f.thread.title).toBe("Contextual reconnect investigation");
    expect(f.thread.activities.some((activity) => activity.kind === "text-generation.failed")).toBe(
      false,
    );
    expect(f.dispatch.mock.calls.every(([command]) => command.type !== "thread.turn.start")).toBe(
      true,
    );
  });
  it("warns only after all three jobs and tool fallback fail; later successes cannot loop", async () => {
    const f = titleFixture();
    await Effect.runPromise(f.run());
    f.addSuccess(1);
    f.addSuccess(2);
    f.addSuccess(3);
    await Effect.runPromise(f.run());
    expect(f.generate).toHaveBeenCalledTimes(4);
    expect(f.thread.activities.at(-1)).toMatchObject({
      kind: "text-generation.failed",
      payload: { operation: "title", finalFailure: true },
    });
    f.addSuccess(4);
    await Effect.runPromise(f.run());
    expect(f.generate).toHaveBeenCalledTimes(4);
    expect(f.thread.title).toBe("New thread");
  });
  it("consumes an ambiguous persisted in-flight stage instead of replaying external work", async () => {
    const f = titleFixture();
    await Effect.runPromise(recordTitleStage(f.services, f.thread, 1, "started"));
    await Effect.runPromise(f.run());
    expect(f.generate).not.toHaveBeenCalled();
    expect(readTitleStage(f.thread, 1)?.state).toBe("uncertain");
  });
  it("preserves manual title locks during a late third-stage result", async () => {
    const f = titleFixture();
    await Effect.runPromise(f.run());
    f.addSuccess(1);
    f.addSuccess(2);
    f.addSuccess(3);
    const gate = Deferred.makeUnsafe<void>();
    f.generate.mockReturnValue(
      Deferred.await(gate).pipe(Effect.as({ title: "Late generated title" })),
    );
    const running = Effect.runPromise(f.run());
    await vi.waitFor(() => expect(f.generate).toHaveBeenCalledTimes(3));
    lockThreadTitle(f.thread.id);
    await Effect.runPromise(f.rename("User-owned title"));
    await Effect.runPromise(Deferred.succeed(gate, undefined));
    await running;
    expect(f.thread.title).toBe("User-owned title");
    expect(f.generate).toHaveBeenCalledTimes(3);
  });
  it("does not retry or warn after cancellation", async () => {
    const f = titleFixture();
    f.generate.mockReturnValue(Effect.interrupt);
    await Effect.runPromiseExit(f.run());
    await Effect.runPromise(f.run());
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(readTitleStage(f.thread, 1)?.state).toBe("cancelled");
    expect(f.thread.activities.some((activity) => activity.kind === "text-generation.failed")).toBe(
      false,
    );
  });
  it("a manual retry after final failure is one metadata-only exact-model tool job, not a pipeline reset", async () => {
    const f = titleFixture();
    await Effect.runPromise(f.run());
    f.addSuccess(1);
    f.addSuccess(2);
    f.addSuccess(3);
    await Effect.runPromise(f.run());
    expect(f.generate).toHaveBeenCalledTimes(4);
    f.generate.mockReturnValueOnce(Effect.succeed({ title: "Manual metadata recovery" }));
    await Effect.runPromise(f.run(true));
    expect(f.generate).toHaveBeenCalledTimes(5);
    expect(f.generate.mock.calls[4]?.[0]).toMatchObject({ verifiedThreadModelOnly: true });
    expect(f.thread.title).toBe("Manual metadata recovery");
    expect(f.thread.activities.at(-1)?.kind).toBe("text-generation.completed");
    await Effect.runPromise(f.run());
    expect(f.generate).toHaveBeenCalledTimes(5);
  });
});
