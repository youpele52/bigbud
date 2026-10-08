import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, it, assert } from "@effect/vitest";
import { Effect, Random, Stream } from "effect";

import { ClaudeAdapter } from "../../Services/Claude/Adapter.ts";
import { readClaudeResumeState } from "./Adapter.utils.ts";
import {
  THREAD_ID,
  makeDeterministicRandomService,
  makeHarness,
  readFirstPromptText,
} from "./Adapter.test.helpers.ts";

describe("ClaudeAdapter single-use query recovery", () => {
  it.effect.each(["failure", "end", "interrupt"] as const)(
    "retires an exhausted query after %s without re-handshake or prompt replay",
    (kind) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });
        const createInput = harness.getLastCreateQueryInput();
        const callback = createInput?.options.canUseTool;
        yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);
        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "uncertain prompt",
          attachments: [],
        });
        assert.equal(
          yield* Effect.promise(() => readFirstPromptText(createInput)),
          "uncertain prompt",
        );
        harness.query.emit({
          type: "system",
          subtype: "status",
          status: null,
          uuid: "11111111-1111-4111-8111-111111111111",
          session_id: "22222222-2222-4222-8222-222222222222",
        } as SDKMessage);
        yield* Stream.filter(adapter.streamEvents, (event) => event.type === "thread.started").pipe(
          Stream.runHead,
        );
        const sessions = yield* adapter.listSessions();
        assert.equal(
          readClaudeResumeState(sessions[0]?.resumeCursor)?.resume,
          "22222222-2222-4222-8222-222222222222",
        );
        if (kind === "failure") harness.query.fail(new Error("transport failed"));
        else if (kind === "interrupt") harness.query.fail(new Error("interrupted by user"));
        else harness.query.finish();
        const events = yield* Stream.takeUntil(
          adapter.streamEvents,
          (event) => event.type === "session.exited",
        ).pipe(Stream.runCollect);
        const completion = events.find((event) => event.type === "turn.completed");
        assert.equal(completion?.type, "turn.completed");
        if (completion?.type === "turn.completed")
          assert.equal(completion.payload.state, kind === "failure" ? "failed" : "interrupted");
        for (let attempt = 0; attempt < 20 && (yield* adapter.hasSession(THREAD_ID)); attempt++)
          yield* Effect.yieldNow;
        assert.isFalse(yield* adapter.hasSession(THREAD_ID));
        assert.equal(harness.query.reinitializeCalls.length, 0);
        assert.equal(harness.query.closeCalls, 1);
        assert.equal(harness.getLastCreateQueryInput(), createInput);
        assert.isFalse(
          events.some(
            (event) => event.type === "session.state.changed" && event.payload.state === "ready",
          ),
        );
        const admission = yield* adapter
          .sendTurn({ threadId: THREAD_ID, input: "next", attachments: [] })
          .pipe(Effect.exit);
        assert.equal(admission._tag, "Failure");
        const stale = yield* Effect.promise(() =>
          callback!(
            "Bash",
            {},
            { signal: new AbortController().signal, requestId: "stale", toolUseID: "stale-tool" },
          ),
        );
        assert.equal(stale?.behavior, "deny");
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );
});
