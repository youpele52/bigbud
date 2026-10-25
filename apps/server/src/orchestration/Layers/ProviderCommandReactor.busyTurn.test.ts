import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ThreadId,
  type ModelSelection,
} from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ProviderAdapterValidationError } from "../../provider/Errors.ts";
import type { OrchestrationThread } from "@bigbud/contracts";
import {
  asMessageId,
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";
import { settleActiveTurn } from "./ProviderCommandReactor.test.settleTurn.ts";

const userMessageIds = (thread: OrchestrationThread | undefined) =>
  (thread?.messages ?? [])
    .filter((message) => message.role === "user")
    .map((message) => message.id);

const CLAUDE_MODEL: ModelSelection = {
  provider: "claudeAgent",
  model: "claude-sonnet-4-6",
};

describe("ProviderCommandReactor busy turn recovery", () => {
  registerProviderCommandReactorTestCleanup();

  it("queues a busy follow-up once and delivers it after the active turn settles", async () => {
    const harness = await createHarness({ threadModelSelection: CLAUDE_MODEL });
    const deliverTurn = harness.sendTurn.getMockImplementation()!;
    harness.sendTurn.mockImplementationOnce((input: unknown) => {
      // The provider is already running `turn-1` when it refuses this follow-up.
      return Effect.andThen(
        deliverTurn(input),
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: "claudeAgent",
            operation: "sendTurn",
            issue:
              "Turn 'turn-1' is already active. Interrupt or wait for it to complete before starting another turn.",
          }),
        ),
      ) as never;
    });
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
      const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads[0];
      return (
        thread?.queuedPrompts?.some((prompt) => prompt.id === "busy-follow-up") === true &&
        thread.session?.status === "running"
      );
    });

    const queued = (await Effect.runPromise(harness.engine.getReadModel())).threads[0];
    expect(userMessageIds(queued)).toEqual(["busy-follow-up"]);
    expect(queued?.queuedPrompts).toMatchObject([{ id: "busy-follow-up", alreadySent: true }]);
    expect(queued?.session).toMatchObject({ status: "running", activeTurnId: "turn-1" });
    expect(
      queued?.activities.some((activity) => activity.kind === "provider.turn.start.failed"),
    ).toBe(false);

    await settleActiveTurn(harness.engine, "cmd-settle-busy-turn", new Date().toISOString(), {
      providerName: "claudeAgent",
      runtimeMode: "full-access",
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    await waitFor(async () => {
      const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads[0];
      return (thread?.queuedPrompts?.length ?? 0) === 0;
    });

    const delivered = (await Effect.runPromise(harness.engine.getReadModel())).threads[0];
    expect(userMessageIds(delivered)).toEqual(["busy-follow-up"]);
    expect(
      harness.sendTurn.mock.calls.map(
        ([input]) => (input as { readonly requestMessageId?: string }).requestMessageId,
      ),
    ).toEqual(["busy-follow-up", "busy-follow-up"]);
  });
});
