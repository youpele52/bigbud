import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
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
  sourceSends,
  THREAD,
} from "./ProviderCommandReactor.sessionRecovery.test.helpers.ts";

const contextLimit = () =>
  Effect.fail(
    new ProviderAdapterRequestError({
      provider: "codex",
      method: "turn/start",
      detail: "maximum context length exceeded",
    }),
  );
/** The retry's fresh session dies while the prompt is being written: it may have been accepted. */
const diedWhileSending = () =>
  Effect.fail(new ProviderAdapterSessionClosedError({ provider: "codex", threadId: THREAD }));

describe("ProviderCommandReactor context-limit retry", () => {
  registerProviderCommandReactorTestCleanup();

  it("reports a post-dispatch failure of the retry as unsafe: no further send, no fork", async () => {
    const harness = await createHarness({ sessionRecovery: "resume-restart" });
    await completeFirstTurn(harness);
    harness.sendTurn.mockImplementationOnce(contextLimit as never);
    harness.sendTurn.mockImplementationOnce(diedWhileSending as never);
    await dispatchTurn(harness, "second", "second question");
    await waitFor(async () => (await failures(harness)).length > 0);
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(sourceSends(harness)).toHaveLength(3); // first turn + attempt + one retry
    expect(harness.sendTurn.mock.calls).toHaveLength(3); // and no fork sent it again
    expect((await failures(harness))[0]?.payload).toMatchObject({
      failureClass: "unsafe-to-replay",
    });
    const threads = (await Effect.runPromise(harness.engine.getReadModel())).threads;
    expect(threads.filter((thread) => thread.forkOrigin !== undefined)).toEqual([]);
  });

  it("ignores a failed stop of the old session: the retry runs, nothing is recorded or forked", async () => {
    const harness = await createHarness({ sessionRecovery: "resume-restart" });
    await completeFirstTurn(harness);
    harness.sendTurn.mockImplementationOnce(contextLimit as never);
    harness.stopSession.mockImplementationOnce((() =>
      Effect.fail(
        new ProviderAdapterSessionNotFoundError({
          provider: "codex",
          threadId: THREAD,
          failureClass: "session-dead",
        }),
      )) as never);
    await dispatchTurn(harness, "second", "second question");
    await waitFor(() => sourceSends(harness).length === 3);
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(await failures(harness)).toEqual([]);
    const threads = (await Effect.runPromise(harness.engine.getReadModel())).threads;
    expect(threads.filter((thread) => thread.forkOrigin !== undefined)).toEqual([]);
  });
});
