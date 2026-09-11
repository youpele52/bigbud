import { CommandId, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  asMessageId,
  createHarness,
  registerProviderCommandReactorTestCleanup,
} from "./ProviderCommandReactor.test.helpers.ts";

describe("ProviderCommandReactor captured event settings", () => {
  registerProviderCommandReactorTestCleanup();

  it("forwards the accepted runtime, model and interaction mode instead of thread defaults", async () => {
    const h = await createHarness();
    const threadId = ThreadId.makeUnsafe("thread-1");
    await Effect.runPromise(
      h.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("captured-runtime-turn"),
        threadId,
        message: {
          messageId: asMessageId("captured-runtime-message"),
          role: "user",
          text: "Use captured settings",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "plan",
        modelSelection: { provider: "codex", model: "captured-model" },
        createdAt: new Date().toISOString(),
      }),
    );
    await h.drain();
    expect(h.startSession.mock.calls[0]?.[1]).toMatchObject({
      runtimeMode: "full-access",
      modelSelection: { model: "captured-model" },
    });
    expect(h.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      interactionMode: "plan",
      modelSelection: { model: "captured-model" },
      input: expect.stringContaining("- runtime: full-access"),
    });
    const thread = (await Effect.runPromise(h.engine.getReadModel())).threads.find(
      (entry) => entry.id === threadId,
    );
    expect(thread).toMatchObject({
      runtimeMode: "approval-required",
      interactionMode: "default",
      session: { runtimeMode: "full-access" },
    });
  });
});
