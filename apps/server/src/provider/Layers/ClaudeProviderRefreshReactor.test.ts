import { EventId, ThreadId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import { TestClock } from "effect/testing";

import {
  isClaudeProviderRefreshTrigger,
  makeCoalescedRefresh,
} from "./ClaudeProviderRefreshReactor.logic.ts";

const base = {
  eventId: EventId.makeUnsafe("event-1"),
  createdAt: "2026-10-16T00:00:00.000Z",
  threadId: ThreadId.makeUnsafe("thread-1"),
};

describe("Claude provider refresh triggers", () => {
  it("fires on changed commands and rate limits for Claude only", () => {
    const configured = (provider: "claudeAgent" | "cliProxy", commandsChanged: boolean) =>
      ({
        ...base,
        provider,
        type: "session.configured",
        payload: { config: { commandsChanged, commandCount: 3 } },
      }) as ProviderRuntimeEvent;
    assert.equal(isClaudeProviderRefreshTrigger(configured("claudeAgent", true)), true);
    assert.equal(isClaudeProviderRefreshTrigger(configured("claudeAgent", false)), false);
    assert.equal(isClaudeProviderRefreshTrigger(configured("cliProxy", true)), false);
    assert.equal(
      isClaudeProviderRefreshTrigger({
        ...base,
        provider: "claudeAgent",
        type: "account.rate-limits.updated",
        payload: { rateLimits: { status: "allowed" } },
      }),
      true,
    );
  });
});

describe("coalesced refresh", () => {
  it.effect("refreshes on the leading edge and once trailing per window", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0);
        const trigger = yield* makeCoalescedRefresh(
          Ref.update(calls, (count) => count + 1),
          "60 seconds",
        );
        yield* trigger;
        yield* Effect.yieldNow;
        assert.equal(yield* Ref.get(calls), 1);
        yield* trigger;
        yield* trigger;
        yield* trigger;
        yield* Effect.yieldNow;
        assert.equal(yield* Ref.get(calls), 1);
        yield* TestClock.adjust("59 seconds");
        yield* Effect.yieldNow;
        assert.equal(yield* Ref.get(calls), 1);
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
        assert.equal(yield* Ref.get(calls), 2);
        // No new trigger: the window closes without another refresh.
        yield* TestClock.adjust("60 seconds");
        yield* Effect.yieldNow;
        assert.equal(yield* Ref.get(calls), 2);
        yield* trigger;
        yield* Effect.yieldNow;
        assert.equal(yield* Ref.get(calls), 3);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
});
