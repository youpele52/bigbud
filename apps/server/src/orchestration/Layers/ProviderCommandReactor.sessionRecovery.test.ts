import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
} from "../../provider/Errors.ts";
import {
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
  startInput,
} from "./ProviderCommandReactor.sessionRecovery.test.helpers.ts";

describe("ProviderCommandReactor in-place session recovery", () => {
  registerProviderCommandReactorTestCleanup();

  it("session-dead: revives (resumes) the same provider session once, without transcript replay", async () => {
    const harness = await createHarness({ sessionRecovery: "resume-restart" });
    await completeFirstTurn(harness);
    harness.sendTurn.mockImplementationOnce(sessionDead as never);
    await dispatchTurn(harness, "second", "second question");
    await settle(harness, 3);

    expect(await failures(harness)).toEqual([]);
    expect(harness.sendTurn.mock.calls).toHaveLength(3);
    expect(harness.stopSession).toHaveBeenCalledTimes(1);
    expect(startInput(harness, 0)?.resumeCursor).toBeUndefined();
    const lastStart = startInput(harness, harness.startSession.mock.calls.length - 1);
    expect(lastStart?.resumeCursor).toEqual({ opaque: "resume-1" });
    expect(sendInput(harness, 2)).not.toContain("Transcript context:");
    expect(await recoveries(harness)).toEqual([
      expect.objectContaining({ step: "revive", outcome: "started" }),
      expect.objectContaining({ step: "revive", outcome: "succeeded" }),
    ]);
  });

  it("session-dead twice: falls back once to a fresh session with transcript replay in the same thread", async () => {
    const harness = await createHarness({ sessionRecovery: "resume-restart" });
    await completeFirstTurn(harness);
    harness.sendTurn.mockImplementationOnce(sessionDead as never);
    harness.sendTurn.mockImplementationOnce(sessionDead as never);
    await dispatchTurn(harness, "second", "second question");
    await settle(harness, 4);

    expect(await failures(harness)).toEqual([]);
    expect(harness.sendTurn.mock.calls).toHaveLength(4);
    const lastStart = startInput(harness, harness.startSession.mock.calls.length - 1);
    expect(lastStart?.resumeCursor).toBeUndefined();
    const replayed = sendInput(harness, 3);
    expect(replayed).toContain("Transcript context:");
    expect(replayed).toContain("USER:\nfirst question");
    expect(replayed).toContain("ASSISTANT:\nfirst answer");
    expect(replayed).toContain("Latest user request (answer this now):\nsecond question");
    expect((await recoveries(harness)).at(-1)).toEqual(
      expect.objectContaining({ step: "fresh-replay", outcome: "succeeded" }),
    );
  });

  it("never loops: when revive and fresh replay both fail, exactly one failure is recorded as session-dead", async () => {
    const harness = await createHarness({ sessionRecovery: "resume-restart" });
    await completeFirstTurn(harness);
    for (let index = 0; index < 5; index++)
      harness.sendTurn.mockImplementationOnce(sessionDead as never);
    await dispatchTurn(harness, "second", "second question");
    await waitFor(async () => (await failures(harness)).length > 0);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(sourceSends(harness)).toHaveLength(4); // first turn + attempt + revive + fresh
    const recorded = await failures(harness);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.payload).toMatchObject({ failureClass: "session-dead" });
    const failedEvents = Array.from(
      await Effect.runPromise(Stream.runCollect(harness.engine.readEvents(0))),
    ).filter((event) => event.type === "thread.turn-start-failed");
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]?.payload).toMatchObject({ failureClass: "session-dead" });
    expect((await recoveries(harness)).at(-1)).toEqual(
      expect.objectContaining({ step: "fresh-replay", outcome: "failed" }),
    );
  });

  it("without native resume support it skips revive and replays into a fresh session once", async () => {
    const harness = await createHarness({ sessionRecovery: "fresh-restart" });
    await completeFirstTurn(harness);
    harness.sendTurn.mockImplementationOnce(sessionDead as never);
    await dispatchTurn(harness, "second", "second question");
    await settle(harness, 3);

    expect(await failures(harness)).toEqual([]);
    expect(harness.sendTurn.mock.calls).toHaveLength(3);
    expect(sendInput(harness, 2)).toContain("Transcript context:");
  });

  const requestError = (detail: string, failureClass?: "invalid-request") =>
    new ProviderAdapterRequestError({
      provider: "codex",
      method: "turn/start",
      detail,
      ...(failureClass ? { failureClass } : {}),
    });
  it.each([
    ["auth-or-quota", () => requestError("401 Unauthorized: invalid API key")],
    [
      "auth-or-quota",
      () => requestError("You have exceeded your quota; check your billing details"),
    ],
    [
      "invalid-request",
      () => requestError("Invalid request: unsupported parameter 'foo'.", "invalid-request"),
    ],
    [
      "unsafe-to-replay",
      () =>
        new ProviderAdapterValidationError({
          provider: "opencodeV2",
          operation: "sendTurn",
          issue:
            "V2 OpenCode did not confirm release of the previous thread-tools enrollment; check OpenCode is running with bigbud thread tools, then send again. Nothing was replayed.",
        }),
    ],
  ])("never auto-recovers %s failures", async (failureClass, makeError) => {
    const harness = await createHarness({ sessionRecovery: "resume-restart" });
    await completeFirstTurn(harness);
    harness.sendTurn.mockImplementationOnce((() => Effect.fail(makeError())) as never);
    await dispatchTurn(harness, "second", "second question");
    await waitFor(async () => (await failures(harness)).length > 0);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(harness.sendTurn.mock.calls).toHaveLength(2);
    expect(harness.stopSession).not.toHaveBeenCalled();
    expect((await failures(harness))[0]?.payload).toMatchObject({ failureClass });
    expect(await recoveries(harness)).toEqual([]);
  });
});
