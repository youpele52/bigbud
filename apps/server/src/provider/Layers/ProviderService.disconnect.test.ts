import { assert } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach } from "vitest";

import { ProviderService } from "../Services/ProviderService.ts";
import { asThreadId, makeProviderServiceLayer } from "./ProviderService.test.helpers.ts";
import {
  configureSshTargetDisconnects,
  markSshTargetDisconnected,
  REMOTE_TARGET_DISCONNECTED_MESSAGE,
} from "../../ssh/sshTargetDisconnects.ts";

const target = "ssh:host=devbox&transport=direct-ssh";
const routing = makeProviderServiceLayer();

afterEach(() => configureSshTargetDisconnects(undefined, []));

routing.layer("ProviderServiceLive with a disconnected remote target", (it) => {
  it.effect("rolls back a session whose start a Disconnect overtook", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-disconnect-during-start");
      const adapter = routing.codex;
      const start = adapter.startSession.getMockImplementation()!;
      // The adapter spawned its SSH child and registers the session after the
      // Disconnect already listed provider sessions.
      adapter.startSession.mockImplementationOnce((input) =>
        Effect.promise(() => markSshTargetDisconnected(target)).pipe(Effect.andThen(start(input))),
      );

      const exit = yield* Effect.exit(
        provider.startSession(threadId, {
          provider: "codex",
          threadId,
          runtimeMode: "full-access",
          providerRuntimeExecutionTargetId: target,
          workspaceExecutionTargetId: target,
        }),
      );

      assert.isTrue(exit._tag === "Failure");
      assert.include(JSON.stringify(exit), REMOTE_TARGET_DISCONNECTED_MESSAGE);
      assert.deepEqual(adapter.stopSession.mock.calls.at(-1), [threadId]);
      const sessions = yield* provider.listSessions();
      assert.isFalse(sessions.some((session) => session.threadId === threadId));
    }),
  );
});
