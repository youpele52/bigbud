import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ThreadId,
  type ModelSelection,
} from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ProviderAdapterValidationError } from "../../provider/Errors.ts";
import {
  asMessageId,
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";

const CLAUDE_MODEL: ModelSelection = {
  provider: "claudeAgent",
  model: "claude-sonnet-4-6",
};

describe("ProviderCommandReactor busy turn recovery", () => {
  registerProviderCommandReactorTestCleanup();

  it("queues a plain follow-up when the provider reports an active turn", async () => {
    const harness = await createHarness({ threadModelSelection: CLAUDE_MODEL });
    harness.sendTurn.mockReturnValue(
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: "claudeAgent",
          operation: "sendTurn",
          issue:
            "Turn 'active-turn' is already active. Interrupt or wait for it to complete before starting another turn.",
        }),
      ) as never,
    );
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-busy-turn-follow-up"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("busy-follow-up"),
          role: "user",
          text: "Please continue when the current work is finished.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return Boolean(
        readModel.threads[0]?.queuedPrompts?.some((prompt) => prompt.id === "busy-follow-up"),
      );
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads[0];
    expect(thread?.queuedPrompts?.map((prompt) => prompt.id)).toContain("busy-follow-up");
    expect(
      thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed"),
    ).toBe(false);
    expect(thread?.session?.status).not.toBe("error");
  });
});
