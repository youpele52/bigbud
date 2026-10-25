import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, EventId, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  createHarness,
  asMessageId,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";
import { recordTitleStage } from "./ProviderCommandReactorSessionOps.title.state.ts";
import type { SessionOpServices } from "./ProviderCommandReactorSessionOps.types.ts";
import { recordThreadTextGenerationStatus } from "../../git/Layers/InternalTextGeneration.status.ts";

describe("staged title startup recovery", () => {
  registerProviderCommandReactorTestCleanup();
  it("does not lose verified success persisted before a deferred initial title's handler could run", async () => {
    const harness = await createHarness({ startReactor: false });
    const threadId = ThreadId.makeUnsafe("thread-1"),
      createdAt = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("fixture:deferred-first-user"),
        threadId,
        message: {
          messageId: asMessageId("fixture:deferred-user"),
          role: "user",
          text: "Investigate persisted title recovery",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );
    await Effect.runPromise(
      recordThreadTextGenerationStatus(harness.engine, threadId, "title", "deferred", {
        titleSeed: "New thread",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        threadId,
        commandId: CommandId.makeUnsafe("fixture:success-before-startup"),
        createdAt,
        activity: {
          id: EventId.makeUnsafe("fixture:success-before-startup"),
          kind: "text-generation.model-succeeded",
          tone: "info",
          summary: "Verified success",
          turnId: null,
          createdAt,
          payload: { provider: "codex", model: "verified-model" },
        },
      }),
    );
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Recovered deferred title" }),
    );
    await harness.startReactor();
    await waitFor(
      async () =>
        (await Effect.runPromise(harness.engine.getReadModel())).threads[0]?.title ===
        "Recovered deferred title",
    );
    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0].successfulModelSelection).toEqual({
      provider: "codex",
      model: "verified-model",
    });
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });
  it("retains a durable ambiguous stage without paying for a later stage or replaying chat", async () => {
    const harness = await createHarness({
      startReactor: false,
      serverSettingsOverrides: {
        textGenerationModelSelection: { provider: "codex", model: "explicit-model" },
      },
    });
    const threadId = ThreadId.makeUnsafe("thread-1");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("fixture:before-restart"),
        threadId,
        message: {
          messageId: asMessageId("fixture:first-user"),
          role: "user",
          text: "Investigate persistent reconnect behavior",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );
    const readThread = async () =>
      (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
        (item) => item.id === threadId,
      )!;
    await Effect.runPromise(
      recordTitleStage(
        { orchestrationEngine: harness.engine } as SessionOpServices,
        await readThread(),
        1,
        "started",
      ),
    );
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Recovered second title stage" }),
    );
    await harness.startReactor();
    await waitFor(async () =>
      (await readThread()).activities.some((item) => item.kind === "text-generation.uncertain"),
    );
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(harness.startSession).not.toHaveBeenCalled();
    await harness.startReactor();
    await harness.drain();
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
  });
});
