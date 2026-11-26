import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ProviderAdapterProcessError } from "../../provider/Errors.ts";
import {
  buildSshPasswordRequiredMessage,
  SshTargetAuthRequiredError,
} from "../../ssh/sshTargetUnavailable.ts";
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

const TARGET = "ssh:host=ice-2-kg&auth=password";
/** What an adapter raises when its SSH transport needs the password again (cause kept). */
const passwordRequired = () =>
  Effect.fail(
    new ProviderAdapterProcessError({
      provider: "codex",
      threadId: THREAD,
      detail: buildSshPasswordRequiredMessage("ice-2-kg"),
      cause: new SshTargetAuthRequiredError(
        TARGET,
        "password",
        buildSshPasswordRequiredMessage("ice-2-kg"),
      ),
    }),
  );

describe("ProviderCommandReactor remote-target turn-start failures", () => {
  registerProviderCommandReactorTestCleanup();

  it("a dead SSH transport is not recovered or forked and carries the remoteTarget marker", async () => {
    const harness = await createHarness({ sessionRecovery: "resume-restart" });
    await completeFirstTurn(harness);
    harness.sendTurn.mockImplementation(passwordRequired as never);
    await dispatchTurn(harness, "second", "second question");
    await waitFor(async () => (await failures(harness)).length > 0);
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(sourceSends(harness)).toHaveLength(2); // first turn + the one failed attempt
    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(await recoveries(harness)).toEqual([]);
    const recorded = await failures(harness);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.payload).toMatchObject({
      failureClass: "auth-or-quota",
      remoteTarget: { reason: "auth-required", executionTargetId: TARGET, authMode: "password" },
    });
    const threads = (await Effect.runPromise(harness.engine.getReadModel())).threads;
    expect(threads.filter((thread) => thread.parentThread?.threadId === THREAD)).toEqual([]);
  });
});
