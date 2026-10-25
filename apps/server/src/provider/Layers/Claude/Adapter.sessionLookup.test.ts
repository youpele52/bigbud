import { ThreadId } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";

import { ClaudeAdapter } from "../../Services/Claude/Adapter.ts";
import { isLiveClaudeSession } from "./Adapter.sessionLookup.ts";
import { makeHarness } from "./Adapter.test.helpers.ts";

const context = (stopped: boolean, status: string) => ({ stopped, session: { status } }) as never;

describe("ClaudeAdapter session lookup before dispatch", () => {
  it.effect("a turn for a thread without a session fails session-dead (nothing written)", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const error = yield* Effect.flip(
        adapter.sendTurn({ threadId: ThreadId.makeUnsafe("thread-missing"), input: "hi" }),
      );
      assert.equal(error._tag, "ProviderAdapterSessionNotFoundError");
      expect(error).toMatchObject({ failureClass: "session-dead" });
    }).pipe(Effect.provide(harness.layer));
  });

  it("never adopts a stopped or closed session", () => {
    expect(isLiveClaudeSession(context(false, "ready"))).toBe(true);
    expect(isLiveClaudeSession(context(false, "closed"))).toBe(false);
    expect(isLiveClaudeSession(context(true, "ready"))).toBe(false);
  });
});
