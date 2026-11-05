import { Effect, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { registerCheckpointReactorTestCleanup } from "./CheckpointReactor.test.helpers.ts";
import {
  createInspectionTerminalHarness,
  waitInspectionDelivery,
} from "./ProviderInspectionTerminal.integration.helpers.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import * as completion from "./ProviderRuntimeIngestion.processor.runtime.completion.ts";

describe("inspected-terminal reliability gate regressions", () => {
  registerCheckpointReactorTestCleanup();

  it("does not publish a terminal after live native confirmation rejects while canonical ownership is unchanged", async () => {
    const h = await createInspectionTerminalHarness("empty");
    try {
      h.rejectNative();
      await h.inspect();
      await h.runPass();
      expect(await h.active()).toHaveLength(1);
      expect((await h.pending())[0]?.acknowledgements).toEqual({
        ingestion: false,
        checkpoint: false,
        recovery: false,
      });
      const thread = (await Effect.runPromise(h.engine.getReadModel())).threads[0]!;
      expect(thread.session?.activeTurnId).toBe("native-inspected-turn");
      expect(thread.checkpoints).toHaveLength(0);
      expect(h.nativeWork).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  it("blocks sends and restart after checkpoint acknowledgement until real terminal finalization succeeds, including after DB/layer restart", async () => {
    const h = await createInspectionTerminalHarness("empty");
    const original = completion.finalizeRuntimeTurn;
    let fail = true;
    let failures = 0;
    let finalized = 0;
    const spy = vi.spyOn(completion, "finalizeRuntimeTurn").mockImplementation((...args) => {
      if (args[0].type === "turn.completed" && fail) {
        failures++;
        return Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: "terminal.finalization",
            detail: "injected terminal finalizer failure",
          }),
        );
      }
      return original(...args).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (args[0].type === "turn.completed") finalized++;
          }),
        ),
      );
    });
    try {
      await h.inspect();
      await h.ingestionDrain();
      await h.drain();
      await h.runPass();
      await h.ingestionDrain();
      expect(failures).toBeGreaterThan(0);
      expect((await h.pending())[0]?.acknowledgements).toMatchObject({
        checkpoint: true,
        ingestion: false,
      });
      expect((await h.trySend())._tag).toBe("Failure");
      expect((await h.tryRestart())._tag).toBe("Failure");
      expect(h.nativeStarts).not.toHaveBeenCalled();
      await h.restartDelivery();
      await h.ingestionDrain();
      expect((await h.pending())[0]?.acknowledgements).toMatchObject({
        checkpoint: true,
        ingestion: false,
      });
      expect((await h.trySend())._tag).toBe("Failure");
      expect((await h.tryRestart())._tag).toBe("Failure");
      expect(h.nativeStarts).not.toHaveBeenCalled();
      expect(finalized).toBe(0);
      fail = false;
      await h.runPass();
      await waitInspectionDelivery(h);
      expect(finalized).toBeGreaterThan(0);
      expect(await h.pending()).toHaveLength(0);
      expect((await h.intent()).disposition).toBe("settled");
      expect((await h.tryRestart())._tag).toBe("Success");
      expect(h.nativeStarts).toHaveBeenCalledTimes(1);
      expect(h.nativeWork).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await h.close();
    }
  });

  it("replaces a partial plan buffer with native complete markdown on first inspection and replays it exactly once", async () => {
    const h = await createInspectionTerminalHarness("plan", "publication");
    try {
      expect(await h.partialPlan()).toBe(true);
      await h.inspect();
      const plans = () =>
        Effect.runPromise(h.engine.getReadModel()).then((model) => model.threads[0]!.proposedPlans);
      expect((await plans()).map((plan) => plan.planMarkdown)).toEqual([
        "## Durable plan\n- ship once",
      ]);
      await h.runPass();
      expect((await plans()).map((plan) => plan.planMarkdown)).toEqual([
        "## Durable plan\n- ship once",
      ]);
      await h.restartDelivery();
      await waitInspectionDelivery(h);
      await h.runPass();
      expect((await plans()).map((plan) => plan.planMarkdown)).toEqual([
        "## Durable plan\n- ship once",
      ]);
      const events = await Effect.runPromise(Stream.runCollect(h.engine.readEvents(0)));
      expect(
        Array.from(events).filter((event) => event.type === "thread.proposed-plan-upserted"),
      ).toHaveLength(1);
      expect(h.nativeWork).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });
});
