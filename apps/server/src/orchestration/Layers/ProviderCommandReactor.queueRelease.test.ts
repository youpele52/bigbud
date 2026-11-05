import { CommandId, MessageId, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";

const threadId = ThreadId.makeUnsafe("thread-1");
describe("server-authoritative queue release with provider reactor", () => {
  registerProviderCommandReactorTestCleanup();
  it("applies idle settings and starts the queued message once without an intermediate flush", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();
    const id = MessageId.makeUnsafe("release-settings");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.submit",
        commandId: CommandId.makeUnsafe("queue-settings"),
        threadId,
        message: { messageId: id, text: "Use these settings" },
        delivery: "queue",
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.queued-prompt.flush",
        commandId: CommandId.makeUnsafe("release-settings"),
        threadId,
        messageIds: [id],
        messageId: id,
        promptVersions: [{ id, createdAt, alreadySent: false }],
        userRelease: true,
        expectedTurnId: null,
        expectedSessionEpoch: 0,
        releaseSettings: {
          runtimeMode: "full-access",
          interactionMode: "default",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
        },
        createdAt,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn).toHaveBeenCalledOnce();
    expect(harness.startSession).toHaveBeenCalledOnce();
    const value = (await Effect.runPromise(harness.engine.getReadModel())).threads[0]!;
    expect(value.runtimeMode).toBe("full-access");
    expect(value.queuedPrompts).toEqual([]);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({ requestMessageId: id });
  });
});
