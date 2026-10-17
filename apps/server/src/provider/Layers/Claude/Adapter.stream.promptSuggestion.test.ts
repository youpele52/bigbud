import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Random, Stream } from "effect";

import { ClaudeAdapter } from "../../Services/Claude/Adapter.ts";
import { THREAD_ID, makeDeterministicRandomService, makeHarness } from "./Adapter.test.helpers.ts";

const SESSION = { session_id: "sdk-session-suggest" };
const result = (ok: boolean) =>
  ({
    type: "result",
    subtype: ok ? "success" : "error_during_execution",
    is_error: !ok,
    errors: ok ? [] : ["boom"],
    ...SESSION,
    uuid: ok ? "result-ok" : "result-failed",
  }) as unknown as SDKMessage;
const promptSuggestion = {
  type: "prompt_suggestion",
  suggestion: "Add tests for the new parser",
  ...SESSION,
  uuid: "suggestion-1",
} as unknown as SDKMessage;
const sentinel = {
  type: "system",
  subtype: "commands_changed",
  commands: [],
  ...SESSION,
  uuid: "sentinel",
} as unknown as SDKMessage;

const isSentinel = (event: ProviderRuntimeEvent) =>
  event.type === "session.configured" &&
  (event.payload.config as { commandsChanged?: boolean } | undefined)?.commandsChanged === true;

/** Runs one turn ending in `ok`, then a prompt suggestion and a sentinel frame. */
const runTurn = (ok: boolean) => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const adapter = yield* ClaudeAdapter;
    const events = yield* adapter.streamEvents.pipe(
      Stream.takeUntil(isSentinel),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* adapter.startSession({
      threadId: THREAD_ID,
      provider: "claudeAgent",
      runtimeMode: "full-access",
    });
    const turn = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });
    harness.query.emit(result(ok));
    harness.query.emit(promptSuggestion);
    harness.query.emit(sentinel);
    const collected = Array.from(yield* Fiber.join(events));
    yield* adapter.stopSession(THREAD_ID);
    return { turnId: turn.turnId, events: collected };
  }).pipe(
    Effect.provideService(Random.Random, makeDeterministicRandomService()),
    Effect.provide(harness.layer),
  );
};

describe("Claude prompt suggestions", () => {
  it.effect("maps prompt_suggestion after result to the turn that just completed", () =>
    Effect.gen(function* () {
      const { turnId, events } = yield* runTurn(true);
      const types = events.map((event) => event.type);
      const suggestion = events.find((event) => event.type === "turn.prompt-suggestion");
      assert.isDefined(suggestion);
      assert.isTrue(types.indexOf("turn.completed") < types.indexOf("turn.prompt-suggestion"));
      if (suggestion?.type === "turn.prompt-suggestion") {
        assert.equal(String(suggestion.turnId), String(turnId));
        assert.deepEqual(suggestion.payload, {
          suggestion: "Add tests for the new parser",
          source: "native",
        });
      }
    }),
  );

  it.effect("drops a suggestion after a failed turn", () =>
    Effect.gen(function* () {
      const { events } = yield* runTurn(false);
      assert.isFalse(events.some((event) => event.type === "turn.prompt-suggestion"));
    }),
  );
});
