import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Random, Stream } from "effect";

import { ClaudeAdapter } from "../../Services/Claude/Adapter.ts";
import { claimNativeMessageId } from "./Adapter.session.runtime.ts";
import { makeDeterministicRandomService, makeHarness, THREAD_ID } from "./Adapter.test.helpers.ts";

describe("Claude recovery native-message deduplication", () => {
  it("claims each native UUID once while allowing messages without UUIDs", () => {
    const seen = new Set<string>();
    const message = { type: "system", uuid: "native-message-1" } as unknown as SDKMessage;

    assert.equal(claimNativeMessageId(seen, message), true);
    assert.equal(claimNativeMessageId(seen, message), false);
    assert.equal(claimNativeMessageId(seen, { type: "system" } as unknown as SDKMessage), true);
  });

  it.effect("suppresses replayed native messages after reinitialize", () => {
    const harness = makeHarness();
    harness.query.setInitializationResponse({} as never);
    harness.query.reopenOnReinitialize = true;
    const replayed = {
      type: "system",
      subtype: "status",
      status: "compacting",
      session_id: "session-1",
      uuid: "status-replayed",
    } as unknown as SDKMessage;
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);
      harness.query.emit(replayed);
      const first = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(first._tag, "Some");
      if (first._tag === "Some" && first.value.type === "session.state.changed") {
        assert.equal(first.value.payload.state, "waiting");
      }

      harness.query.fail(new Error("transport lost"));
      for (
        let attempt = 0;
        attempt < 20 && harness.query.reinitializeCalls.length === 0;
        attempt += 1
      ) {
        yield* Effect.yieldNow;
      }
      assert.equal(harness.query.reinitializeCalls.length, 1);
      harness.query.emit(replayed);
      harness.query.emit({
        ...replayed,
        status: null,
        uuid: "status-after-recovery",
      } as unknown as SDKMessage);
      const afterRecovery = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(afterRecovery._tag, "Some");
      if (afterRecovery._tag === "Some" && afterRecovery.value.type === "session.state.changed") {
        assert.equal(afterRecovery.value.payload.state, "running");
      }
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});
