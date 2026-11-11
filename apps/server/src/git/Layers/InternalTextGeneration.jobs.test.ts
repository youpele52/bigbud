import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { maybeGenerateThreadElevatorSummary } from "../../orchestration/Layers/ProviderCommandReactorHandlers.elevatorSummary.ts";
import type { SessionOpServices } from "../../orchestration/Layers/ProviderCommandReactorSessionOps.types.ts";
import type { MetadataSummaryRequest } from "../../orchestration/Layers/ThreadMetadataGeneration.requests.ts";
import { MetadataCoordinatorError } from "../../orchestration/Layers/ThreadMetadataGeneration.coordinator.types.ts";

function fixture() {
  const thread = {
    id: ThreadId.makeUnsafe("fixture"),
    title: "Keep this title",
    elevatorSummary: "Keep this summary",
  };
  const summary = vi.fn(
    (_input: MetadataSummaryRequest): Effect.Effect<void, MetadataCoordinatorError> => Effect.void,
  );
  const generate = vi.fn(() => Effect.die("Legacy provider must not run"));
  const dispatch = vi.fn(() => Effect.void);
  const services = {
    metadataGeneration: { summary, title: () => Effect.void, start: () => Effect.void },
    orchestrationEngine: { dispatch },
    textGeneration: { generateThreadElevatorSummary: generate },
  } as unknown as SessionOpServices;
  return { thread, summary, generate, dispatch, run: maybeGenerateThreadElevatorSummary(services) };
}

// Retry budgets and canonical writes are tested through ThreadMetadataGeneration.production.test.ts.
describe("internal summary request boundary", () => {
  it("keeps existing content on admission failure without running a second generator", async () => {
    const test = fixture();
    test.summary.mockReturnValue(
      Effect.fail(new MetadataCoordinatorError({ detail: "Persistence unavailable" })),
    );
    await Effect.runPromise(test.run({ threadId: test.thread.id }));
    expect(test.summary).toHaveBeenCalledTimes(1);
    expect(test.generate).not.toHaveBeenCalled();
    expect(test.dispatch).not.toHaveBeenCalled();
    expect(test.thread.elevatorSummary).toBe("Keep this summary");
    expect(test.thread.title).toBe("Keep this title");
  });

  it("forwards only the stable explicit retry identity and force flag", async () => {
    const test = fixture();
    const request = { threadId: test.thread.id, force: true, retryKey: "persisted-request-1" };
    await Effect.runPromise(test.run(request));
    expect(test.summary).toHaveBeenCalledExactlyOnceWith(request);
    expect(test.generate).not.toHaveBeenCalled();
  });

  it("propagates cancellation without a metadata write or paid fallback", async () => {
    const test = fixture();
    test.summary.mockReturnValue(Effect.interrupt);
    const exit = await Effect.runPromiseExit(test.run({ threadId: test.thread.id }));
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(test.dispatch).not.toHaveBeenCalled();
    expect(test.generate).not.toHaveBeenCalled();
    expect(test.thread.elevatorSummary).toBe("Keep this summary");
  });
});
