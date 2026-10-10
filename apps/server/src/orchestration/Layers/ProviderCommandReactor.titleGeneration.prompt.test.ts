import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { resetThreadTitleLockForTests } from "../../orchestration-tools/ThreadTitleLock.ts";
import {
  asMessageId,
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";

describe("ProviderCommandReactor title prompt", () => {
  registerProviderCommandReactorTestCleanup();
  afterEach(() => resetThreadTitleLockForTests());
  it("generates a thread title even when the outgoing prompt is reformatted", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Reconnect spinner resume bug" }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-title-formatted"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-formatted"),
          role: "user",
          text: "[effort:high]\\n\\nFix reconnect spinner on resume",
          attachments: [],
        },
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"))?.title ===
        "Reconnect spinner resume bug"
      );
    });
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.title).toBe("Reconnect spinner resume bug");
  });
});
