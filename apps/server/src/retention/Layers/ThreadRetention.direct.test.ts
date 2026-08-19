import { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { runDirectThreadRetention } from "./ThreadRetention.direct.ts";

const retentionRun = { runId: "retention-direct-run" };

describe("runDirectThreadRetention", () => {
  it("claims a retention run item then dispatches thread.retention-delete", async () => {
    const threadId = ThreadId.makeUnsafe("retention-thread");
    let deleted = false;
    const dispatch = vi.fn(() =>
      Effect.sync(() => {
        deleted = true;
        return { sequence: 1 };
      }),
    );
    const createOrGetActiveRun = vi.fn(() => Effect.succeed(retentionRun));
    const insertSelectedItems = vi.fn(() => Effect.succeed(1));
    const transitionRun = vi.fn(() => Effect.succeed(true));
    const deleteNow = vi.fn();
    let page = 0;

    const result = await Effect.runPromise(
      runDirectThreadRetention({
        policy: "1-day",
        trigger: "manual",
        now: () => Date.parse("2026-08-18T00:00:00.000Z"),
        repository: {
          createOrGetActiveRun,
          insertSelectedItems,
          transitionRun,
          selectNextPage: () =>
            Effect.succeed(
              page++ === 0 ? [{ threadId, lastActivityAt: "2026-08-16T00:00:00.000Z" }] : [],
            ),
        } as never,
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

    expect(createOrGetActiveRun).toHaveBeenCalled();
    expect(insertSelectedItems).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: retentionRun.runId,
        candidates: [expect.objectContaining({ threadId })],
      }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.retention-delete",
        threadId,
        runId: retentionRun.runId,
      }),
    );
    expect(deleteNow).not.toHaveBeenCalled();
    expect(result.deletedCount).toBe(1);
    expect(result.pendingCount).toBe(0);
    expect(transitionRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: retentionRun.runId,
        nextStatus: "completed",
      }),
    );
  });

  it("uses the preview cutoff and treats a remaining deletedAt marker as deleted", async () => {
    const threadId = ThreadId.makeUnsafe("retention-cutoff-thread");
    const cutoffAt = "2026-07-01T00:00:00.000Z";
    const selectNextPage = vi.fn((input: { readonly cutoffAt: string }) =>
      Effect.succeed(
        input.cutoffAt === cutoffAt
          ? [{ threadId, lastActivityAt: "2026-06-01T00:00:00.000Z" }]
          : [],
      ),
    );
    let calls = 0;

    const result = await Effect.runPromise(
      runDirectThreadRetention({
        policy: "14-days",
        trigger: "manual",
        cutoffAt,
        now: () => Date.parse("2026-08-18T00:00:00.000Z"),
        repository: {
          createOrGetActiveRun: () => Effect.succeed(retentionRun),
          insertSelectedItems: () => Effect.succeed(1),
          transitionRun: () => Effect.succeed(true),
          selectNextPage: (input: { readonly cutoffAt: string }) => {
            calls += 1;
            return calls === 1 ? selectNextPage(input) : Effect.succeed([]);
          },
        } as never,
        orchestration: {
          dispatch: () => Effect.succeed({ sequence: 1 }),
          getReadModel: () =>
            Effect.succeed({
              threads: [
                {
                  id: threadId,
                  deletedAt: "2026-08-18T00:00:01.000Z",
                  deletingAt: null,
                  parentThread: undefined,
                },
              ],
            } as never),
        } as never,
      }),
    );

    expect(selectNextPage).toHaveBeenCalledWith(expect.objectContaining({ cutoffAt, limit: 250 }));
    expect(result.cutoffAt).toBe(cutoffAt);
    expect(result.deletedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(result.pendingCount).toBe(0);
  });

  it("does not count a still-deleting timeout as skipped", async () => {
    const threadId = ThreadId.makeUnsafe("retention-pending-thread");
    const transitionRun = vi.fn(() => Effect.succeed(true));
    let page = 0;

    const result = await Effect.runPromise(
      runDirectThreadRetention({
        policy: "1-day",
        trigger: "manual",
        now: () => Date.parse("2026-08-18T00:00:00.000Z"),
        settleTimeoutMs: 0,
        repository: {
          createOrGetActiveRun: () => Effect.succeed(retentionRun),
          insertSelectedItems: () => Effect.succeed(1),
          transitionRun,
          selectNextPage: () =>
            Effect.succeed(
              page++ === 0 ? [{ threadId, lastActivityAt: "2026-08-16T00:00:00.000Z" }] : [],
            ),
        } as never,
        orchestration: {
          dispatch: () => Effect.succeed({ sequence: 1 }),
          getReadModel: () =>
            Effect.succeed({
              threads: [
                {
                  id: threadId,
                  deletedAt: null,
                  deletingAt: "2026-08-18T00:00:00.000Z",
                  parentThread: undefined,
                },
              ],
            } as never),
        } as never,
      }),
    );

    expect(result.deletedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(result.pendingCount).toBe(1);
    expect(transitionRun).toHaveBeenCalledWith(
      expect.objectContaining({ nextStatus: "completed_with_failures" }),
    );
  });
});
