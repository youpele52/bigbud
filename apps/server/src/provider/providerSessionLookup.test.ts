import { ThreadId } from "@bigbud/contracts";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { requireLiveAdapterSession } from "./providerSessionLookup.ts";

const THREAD = ThreadId.makeUnsafe("thread-lookup");

describe("requireLiveAdapterSession", () => {
  it("returns a live session", () => {
    const exit = Effect.runSyncExit(
      requireLiveAdapterSession({ provider: "copilot", threadId: THREAD, session: { id: 1 } }),
    );
    expect(exit).toEqual(Exit.succeed({ id: 1 }));
  });

  it("fails a missing or dead session as session-dead: nothing was written yet", () => {
    const missing = requireLiveAdapterSession({
      provider: "copilot",
      threadId: THREAD,
      session: undefined,
    });
    const stopped = requireLiveAdapterSession({
      provider: "cursor",
      threadId: THREAD,
      session: { stopped: true },
      isLive: (session) => !session.stopped,
    });
    for (const effect of [missing, stopped]) {
      const error = Effect.runSync(Effect.flip(effect));
      expect(error._tag).toBe("ProviderAdapterSessionNotFoundError");
      expect(error.failureClass).toBe("session-dead");
      expect(error.threadId).toBe(THREAD);
    }
  });
});
