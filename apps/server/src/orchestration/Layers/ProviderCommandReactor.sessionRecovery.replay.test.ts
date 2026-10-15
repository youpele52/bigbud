import { type ChatAttachment, CommandId } from "@bigbud/contracts";
import { Cache, Duration, Effect } from "effect";
import { describe, expect, it } from "vitest";

import { markTurnStartHandled } from "./ProviderCommandReactorHandlers.events.ts";
import {
  asMessageId,
  asTurnId,
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";
import {
  completeFirstTurn,
  dispatchTurn,
  failures,
  recoveries,
  sendInput,
  sessionDead,
  settle,
  sourceSends,
  THREAD,
} from "./ProviderCommandReactor.sessionRecovery.test.helpers.ts";
import { settleActiveTurn } from "./ProviderCommandReactor.test.settleTurn.ts";

const IMAGE: ChatAttachment = {
  type: "image",
  id: "thread-attachment-00000000-0000-4000-8000-000000000042",
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 4,
};

describe("ProviderCommandReactor fresh-session transcript replay", () => {
  registerProviderCommandReactorTestCleanup();

  it("replays the transcript with attachments forwarded and the uncertain turn excluded", async () => {
    const harness = await createHarness({ sessionRecovery: "resume-restart" });
    await completeFirstTurn(harness);
    // Second turn starts but only streams a partial answer before the provider session dies.
    await dispatchTurn(harness, "second", "uncertain question");
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.makeUnsafe("cmd-assistant-second-delta"),
        threadId: THREAD,
        messageId: asMessageId("assistant-second"),
        turnId: asTurnId("turn-1"),
        delta: "partial answer",
        createdAt: new Date(Date.now() + 700).toISOString(),
      }),
    );
    await settleActiveTurn(harness.engine, "cmd-second-settled", new Date().toISOString());
    harness.sendTurn.mockImplementationOnce(sessionDead as never);
    harness.sendTurn.mockImplementationOnce(sessionDead as never);
    await dispatchTurn(harness, "third", "what is in this image?", [IMAGE]);
    await settle(harness, 5);

    expect(await failures(harness)).toEqual([]);
    expect(harness.sendTurn.mock.calls).toHaveLength(5);
    const replayed = sendInput(harness, 4);
    expect(replayed).toContain("Transcript context:");
    expect(replayed).toContain("ASSISTANT:\nfirst answer");
    expect(replayed).not.toContain("uncertain question");
    expect(replayed).not.toContain("partial answer");
    expect(replayed).toContain("Latest user request (answer this now):\nwhat is in this image?");
    const forwarded = harness.sendTurn.mock.calls[4]?.[0] as { attachments?: unknown };
    expect(forwarded.attachments).toEqual([IMAGE]);
    expect((await recoveries(harness)).at(-1)).toEqual(
      expect.objectContaining({ step: "fresh-replay", outcome: "succeeded" }),
    );
  });

  it("does not recover again when the same turn-start command is redelivered", async () => {
    const harness = await createHarness({ sessionRecovery: "resume-restart" });
    await completeFirstTurn(harness);
    harness.sendTurn.mockImplementation(sessionDead as never);
    await dispatchTurn(harness, "second", "second question");
    await waitFor(async () => (await failures(harness)).length > 0);
    await dispatchTurn(harness, "second", "second question").catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(sourceSends(harness)).toHaveLength(4);
    expect(await failures(harness)).toHaveLength(1);
  });

  it("marks a turn-start key handled exactly once", async () => {
    const outcomes = await Effect.runPromise(
      Effect.gen(function* () {
        const cache = yield* Cache.make<string, true>({
          capacity: 10,
          timeToLive: Duration.minutes(1),
          lookup: () => Effect.succeed(true),
        });
        const first = yield* markTurnStartHandled(cache, "command:cmd-turn-second");
        const second = yield* markTurnStartHandled(cache, "command:cmd-turn-second");
        return [first, second];
      }),
    );
    expect(outcomes).toEqual([false, true]);
  });
});
