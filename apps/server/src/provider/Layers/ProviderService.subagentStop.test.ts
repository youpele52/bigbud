import { assert } from "@effect/vitest";
import { Effect } from "effect";

import { ProviderService } from "../Services/ProviderService.ts";
import { asThreadId, makeProviderServiceLayer } from "./ProviderService.test.helpers.ts";

const routing = makeProviderServiceLayer();
routing.layer("ProviderServiceLive per-subagent Stop", (it) => {
  it.effect("routes Stop to the live session of a provider that declares it", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-stop-claude");
      yield* provider.startSession(threadId, {
        provider: "claudeAgent",
        threadId,
        runtimeMode: "full-access",
      });
      assert.isDefined(provider.stopSubagent);
      yield* provider.stopSubagent!({ threadId, nativeTaskId: "task-a" });
      assert.deepEqual(routing.claude.stopSubagent.mock.calls, [[threadId, "task-a"]]);
      assert.equal(routing.claude.interruptTurn.mock.calls.length, 0);
      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect("rejects providers without per-subagent Stop", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-stop-codex");
      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      const result = yield* Effect.result(
        provider.stopSubagent!({ threadId, nativeTaskId: "task-a" }),
      );
      assert.equal(result._tag, "Failure");
      assert.equal(routing.codex.stopSubagent.mock.calls.length, 0);
      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect("never recovers or starts a session to stop a subagent", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const priorStarts = routing.claude.startSession.mock.calls.length;
      const result = yield* Effect.result(
        provider.stopSubagent!({ threadId: asThreadId("thread-no-session"), nativeTaskId: "t" }),
      );
      assert.equal(result._tag, "Failure");
      assert.equal(routing.claude.startSession.mock.calls.length, priorStarts);
    }),
  );

  it.effect("validates the native task ID", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const result = yield* Effect.result(
        provider.stopSubagent!({ threadId: asThreadId("thread-stop-claude"), nativeTaskId: " " }),
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure._tag, "ProviderValidationError");
    }),
  );
});
