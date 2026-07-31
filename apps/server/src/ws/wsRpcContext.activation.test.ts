import { Deferred, Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeCoalescedPromiseEffect } from "./wsRpcContext.ts";

describe("makeCoalescedPromiseEffect", () => {
  it("shares one activation promise across concurrent callers", async () => {
    const deferred = await Effect.runPromise(Deferred.make<void>());
    const operation = vi.fn(() =>
      Effect.promise(async () => {
        await Effect.runPromise(Deferred.await(deferred));
        return "refreshed" as const;
      }),
    );
    const activate = makeCoalescedPromiseEffect(operation);

    const first = activate();
    const second = activate();
    await Effect.runPromise(Deferred.succeed(deferred, undefined));

    await expect(
      Promise.all([Effect.runPromise(first), Effect.runPromise(second)]),
    ).resolves.toEqual(["refreshed", "refreshed"]);
    expect(operation).toHaveBeenCalledOnce();
  });
});
