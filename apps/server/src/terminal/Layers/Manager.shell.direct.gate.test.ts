import * as Effect from "effect/Effect";
import { expect, it } from "vitest";
import { preflightDirectShellLaunch } from "./Manager.shell.direct";
import { fixture, intent } from "./DirectShellLaunch.dispatch.test.helpers";

it.each(["ssh:host=example.test&user=tester&transport=direct-ssh", "wsl:Ubuntu"])(
  "refuses exact direct launch before reservation: %s",
  async (executionTargetId) => {
    const test = fixture();
    const stored = intent().launch;
    const result = await Effect.runPromise(
      preflightDirectShellLaunch(test.store, {
        threadId: "thread",
        terminalId: "pane",
        executionTargetId,
        cwd: "/work",
        launch: {
          shell: stored.executable,
          args: stored.args,
          platform: "linux",
          dropPathMode: "posix",
          identity: {
            ...stored.requestedProfile,
            selection: { kind: "profile", profileId: stored.requestedProfile.profileId },
            integration: { status: "disabled" },
          },
        },
      }).pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.detail).toContain("No replacement");
    expect(test.store.reserve).not.toHaveBeenCalled();
    expect(test.transport).not.toHaveBeenCalled();
  },
);
it("preserves legacy launch preflight", async () => {
  const test = fixture();
  await Effect.runPromise(
    preflightDirectShellLaunch(test.store, {
      threadId: "thread",
      terminalId: "pane",
      executionTargetId: "ssh:host=example.test&transport=direct-ssh",
      cwd: "/work",
      launch: null,
    }),
  );
  expect(test.store.reserve).not.toHaveBeenCalled();
});
