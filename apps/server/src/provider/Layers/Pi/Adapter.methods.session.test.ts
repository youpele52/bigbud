import { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { requirePiSession } from "./Adapter.methods.session.ts";

describe("Pi session lookup before dispatch", () => {
  it("a missing session fails session-dead (nothing written)", () => {
    const error = Effect.runSync(
      Effect.flip(requirePiSession(new Map(), ThreadId.makeUnsafe("thread-pi"))),
    );
    expect(error).toMatchObject({
      _tag: "ProviderAdapterSessionNotFoundError",
      provider: "pi",
      failureClass: "session-dead",
    });
  });
});
