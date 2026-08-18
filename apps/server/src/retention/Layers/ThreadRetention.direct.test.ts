import { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { runDirectThreadRetention } from "./ThreadRetention.direct.ts";

describe("runDirectThreadRetention", () => {
  it("requests deletion through orchestration instead of running a local no-op deletion", async () => {
    const threadId = ThreadId.makeUnsafe("retention-thread");
    let deleted = false;
    const dispatch = vi.fn(() =>
      Effect.sync(() => {
        deleted = true;
        return { sequence: 1 };
      }),
    );
    const deleteNow = vi.fn();
    let page = 0;

    const result = await Effect.runPromise(
      runDirectThreadRetention({
        policy: "1-day",
        trigger: "manual",
        now: () => Date.parse("2026-08-18T00:00:00.000Z"),
        repository: {
          selectNextPage: () =>
            Effect.succeed(
              page++ === 0 ? [{ threadId, lastActivityAt: "2026-08-16T00:00:00.000Z" }] : [],
            ),
        },
        orchestration: {
          dispatch,
          getReadModel: () =>
            Effect.succeed({
              threads: deleted ? [] : [{ id: threadId, deletedAt: null, parentThread: undefined }],
            } as never),
          threadDeletion: { deleteNow },
        } as never,
      }),
    );

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.delete", threadId }),
    );
    expect(deleteNow).not.toHaveBeenCalled();
    expect(result.deletedCount).toBe(1);
  });
});
