import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProviderAdapterRequestError,
  ProviderSessionNotFoundError,
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
  sourceSends,
  THREAD,
} from "./ProviderCommandReactor.sessionRecovery.test.helpers.ts";

/** A turn must never be sent twice: only failures proven to precede dispatch are resent. */
const connectionReset = (method: string) =>
  new ProviderAdapterRequestError({ provider: "codex", method, detail: "read ECONNRESET" });
/** Raised by provider routing before any adapter dispatch: the provider never saw the turn. */
const routedSessionMissing = () =>
  Effect.fail(new ProviderSessionNotFoundError({ threadId: THREAD }));
const settled = async (harness: Awaited<ReturnType<typeof createHarness>>) => {
  await waitFor(async () => (await failures(harness)).length > 0);
  await new Promise((resolve) => setTimeout(resolve, 300)); // Prove no further attempt.
};

describe("ProviderCommandReactor recovery never resends a possibly dispatched turn", () => {
  registerProviderCommandReactorTestCleanup();

  it("an unknown failure after revive is never followed by a fresh resend", async () => {
    const harness = await createHarness({ sessionRecovery: "resume-restart" });
    await completeFirstTurn(harness);
    harness.sendTurn.mockImplementationOnce(routedSessionMissing as never);
    harness.sendTurn.mockImplementationOnce((() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "turn/start",
          detail: "Timed out waiting for turn/start.",
        }),
      )) as never);
    await dispatchTurn(harness, "second", "second question");
    await settled(harness);

    expect(sourceSends(harness)).toHaveLength(3); // first turn + attempt + revive, no fresh
    expect((await recoveries(harness)).map((entry) => `${entry.step}:${entry.outcome}`)).toEqual([
      "revive:started",
      "revive:failed",
    ]);
    expect((await failures(harness))[0]?.payload).toMatchObject({ failureClass: "unknown" });
  });

  it("a connection error raised by the send itself is unsafe to replay and never resent", async () => {
    const harness = await createHarness({ sessionRecovery: "resume-restart" });
    await completeFirstTurn(harness);
    harness.sendTurn.mockImplementationOnce((() =>
      Effect.fail(connectionReset("turn/start"))) as never);
    await dispatchTurn(harness, "second", "second question");
    await settled(harness);

    expect(sourceSends(harness)).toHaveLength(2);
    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(await recoveries(harness)).toEqual([]);
    expect((await failures(harness))[0]?.payload).toMatchObject({
      failureClass: "unsafe-to-replay",
    });
  });

  it("a plain dead-session error after dispatch is recorded unsafe: no resend, no fork", async () => {
    const harness = await createHarness({ sessionRecovery: "resume-restart" });
    await completeFirstTurn(harness);
    harness.sendTurn.mockImplementationOnce((() =>
      Effect.fail(new Error("Connection is closed."))) as never);
    await dispatchTurn(harness, "second", "second question");
    await settled(harness);

    expect(sourceSends(harness)).toHaveLength(2);
    expect(await recoveries(harness)).toEqual([]);
    expect((await failures(harness))[0]?.payload).toMatchObject({
      detail: "Connection is closed.",
      failureClass: "unsafe-to-replay",
    });
    const threads = (await Effect.runPromise(harness.engine.getReadModel())).threads;
    expect(threads.filter((thread) => thread.forkOrigin !== undefined)).toEqual([]);
  });

  it("a connection error before dispatch (session start) gets one bounded recovery", async () => {
    const harness = await createHarness({ sessionRecovery: "resume-restart" });
    harness.startSession.mockImplementationOnce((() =>
      Effect.fail(connectionReset("session/new"))) as never);
    await dispatchTurn(harness, "first", "first question");
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(harness.startSession).toHaveBeenCalledTimes(2);
    expect(sourceSends(harness)).toHaveLength(1);
    expect(await failures(harness)).toEqual([]);
    expect((await recoveries(harness)).map((entry) => `${entry.step}:${entry.outcome}`)).toEqual([
      "fresh-replay:started",
      "fresh-replay:succeeded",
    ]);
  });
});
