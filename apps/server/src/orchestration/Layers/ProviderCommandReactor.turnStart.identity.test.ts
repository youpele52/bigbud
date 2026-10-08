import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  asMessageId,
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";
import { settleActiveTurn } from "./ProviderCommandReactor.test.settleTurn.ts";

describe("ProviderCommandReactor request identity", () => {
  registerProviderCommandReactorTestCleanup();

  it("assigns distinct identities to identical intentional submissions", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await dispatchTurn(harness.engine, "first", "identical-prompt-first", now);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await settleActiveTurn(harness.engine, "cmd-identical-prompt-first-settled", now);

    await dispatchTurn(harness.engine, "second", "identical-prompt-second", now);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(
      harness.sendTurn.mock.calls.map(
        ([input]) => (input as { requestMessageId?: string }).requestMessageId,
      ),
    ).toEqual(["identical-prompt-first", "identical-prompt-second"]);
  });
});

function dispatchTurn(
  engine: Awaited<ReturnType<typeof createHarness>>["engine"],
  suffix: string,
  messageId: string,
  createdAt: string,
) {
  return Effect.runPromise(
    engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe(`cmd-identical-prompt-${suffix}`),
      threadId: ThreadId.makeUnsafe("thread-1"),
      message: {
        messageId: asMessageId(messageId),
        role: "user",
        text: "same intentional prompt",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt,
    }),
  );
}
