import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, ThreadId } from "@bigbud/contracts";
import { Deferred, Effect } from "effect";
import { describe, it } from "vitest";

import {
  asMessageId,
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";

describe("ProviderCommandReactor", () => {
  registerProviderCommandReactorTestCleanup();

  it("projects starting before a slow provider session startup completes", async () => {
    const harness = await createHarness();
    const startup = await Effect.runPromise(Deferred.make<void>());
    const now = new Date().toISOString();
    harness.startSession.mockImplementationOnce(
      () =>
        Deferred.await(startup).pipe(
          Effect.as({
            provider: "codex" as const,
            status: "ready" as const,
            runtimeMode: "approval-required" as const,
            threadId: ThreadId.makeUnsafe("thread-1"),
            createdAt: now,
            updatedAt: now,
          }),
        ) as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-slow-session"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-slow-session"),
          role: "user",
          text: "hello slow session",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"))?.session
          ?.status === "starting"
      );
    });
    await Effect.runPromise(Deferred.succeed(startup, undefined));
    await harness.drain();
  });
});
