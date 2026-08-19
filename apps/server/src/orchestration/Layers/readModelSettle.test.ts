import { Duration, Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { waitForReadModelCondition } from "./readModelSettle.ts";

describe("waitForReadModelCondition", () => {
  it("returns immediately when the check is already done", async () => {
    const result = await Effect.runPromise(
      waitForReadModelCondition({
        check: Effect.succeed({ done: true, value: "ready" }),
        events: Stream.never,
        timeout: Duration.seconds(1),
        onTimeout: "timeout",
      }),
    );
    expect(result).toBe("ready");
  });

  it("returns the timeout value when the check never completes", async () => {
    const result = await Effect.runPromise(
      waitForReadModelCondition({
        check: Effect.succeed({ done: false }),
        events: Stream.empty,
        timeout: Duration.millis(10),
        onTimeout: "timeout",
      }),
    );
    expect(result).toBe("timeout");
  });
});
