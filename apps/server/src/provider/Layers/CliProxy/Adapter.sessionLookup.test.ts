import { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { requireCliProxySession } from "./Adapter.ts";

describe("CLIProxy session lookup before dispatch", () => {
  it("a missing or closed session fails session-dead (nothing written)", () => {
    const threadId = ThreadId.makeUnsafe("thread-cli");
    for (const sessions of [[], [{ threadId, status: "closed" }]]) {
      const error = Effect.runSync(
        Effect.flip(requireCliProxySession(sessions as never, threadId)),
      );
      expect(error).toMatchObject({
        _tag: "ProviderAdapterSessionNotFoundError",
        provider: "cliProxy",
        failureClass: "session-dead",
      });
    }
  });
});
