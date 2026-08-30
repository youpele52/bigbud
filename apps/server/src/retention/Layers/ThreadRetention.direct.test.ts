import { ThreadId } from "@bigbud/contracts";
import { Effect, Layer, ManagedRuntime, Option, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import { runDirectThreadRetention } from "./ThreadRetention.direct.ts";
import { ThreadRetentionLive } from "./ThreadRetention.ts";
import { ThreadRetention } from "../Services/ThreadRetention.ts";
import { ThreadRetentionRepository } from "../../persistence/Services/ThreadRetentionRepository.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import type { WsRpcContext } from "../../ws/wsRpcContext.ts";
import { makeThreadRetentionWsRpcHandlers } from "../../ws/wsRpcHandlers.retention.ts";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import type {
  ThreadRetentionRun,
  ThreadRetentionRunItem,
} from "../../persistence/Services/ThreadRetentionRepository.ts";
import { retentionRun, runnerRepository } from "./ThreadRetention.direct.test.helpers.ts";

describe("runDirectThreadRetention", () => {
  it("carries a valid manual 7-day preview challenge into an eligible Delete Now command", async () => {
    const threadId = ThreadId.makeUnsafe("retention-seven-day-thread");
    const challengeToken = "valid-seven-day-preview";
    let issuedChallenge:
      | { readonly token: string; readonly policy: "7-days"; readonly cutoffAt: string }
      | undefined;
    let persistedRun: ThreadRetentionRun = retentionRun;
    let active = false;
    const consumeChallengeAndCreateRun = vi.fn(({ token }: { readonly token: string }) => {
      if (token !== issuedChallenge?.token) {
        return Effect.succeed({ consumed: false as const, result: "invalid" as const });
      }
      persistedRun = {
        ...retentionRun,
        policy: issuedChallenge.policy,
        cutoffAt: issuedChallenge.cutoffAt,
        status: "queued",
      };
      return Effect.succeed({ consumed: true as const, run: persistedRun, created: true });
    });
    const repository = {
      preview: () =>
        Effect.succeed({
          eligibleCount: 1,
          oldestEligibleActivityAt: "2026-08-10T00:00:00.000Z",
          newestEligibleActivityAt: "2026-08-10T00:00:00.000Z",
          exclusionCounts: [],
          estimatedAttachmentCount: 0,
          estimatedResourceCount: 0,
          estimatedKnownBytes: 0,
          attachmentEstimateComplete: true,
          resourceEstimateComplete: true,
          bytesEstimateComplete: true,
        }),
      issueChallenge: (input: {
        readonly challengeId: string;
        readonly trigger: "manual" | "policy-change";
        readonly policy: "7-days" | "14-days" | "30-days" | "90-days";
        readonly cutoffAt: string;
        readonly issuedAt: string;
        readonly expiresAt: string;
      }) =>
        Effect.sync(() => {
          issuedChallenge = { token: challengeToken, policy: "7-days", cutoffAt: input.cutoffAt };
          return { ...input, token: challengeToken };
        }),
      consumeChallengeAndCreateRun,
      getRun: () => Effect.succeed(Option.some(persistedRun)),
      listRecoverableRuns: () =>
        Effect.succeed(active ? [{ ...persistedRun, status: "selecting" as const }] : []),
      listQueuedManualRuns: () => Effect.succeed([]),
      claimNextQueuedRun: () =>
        Effect.sync(() => {
          active = true;
          persistedRun = { ...persistedRun, status: "selecting" };
          return Option.some(persistedRun);
        }),
      listOutstandingItems: () => Effect.succeed([]),
      insertSelectedPage: () =>
        Effect.succeed({ applied: true, insertedCount: 1, outstandingBacklogCount: 1 }),
      transitionRun: (input: { readonly nextStatus: ThreadRetentionRun["status"] }) =>
        Effect.sync(() => {
          persistedRun = { ...persistedRun, status: input.nextStatus };
          return true;
        }),
      findItemByDeletionCommandId: () =>
        Effect.succeed(Option.some({ status: itemStatus } as ThreadRetentionRunItem)),
      transitionItem: (input: { readonly nextStatus: ThreadRetentionRunItem["status"] }) =>
        Effect.sync(() => {
          itemStatus = input.nextStatus;
          persistedRun = {
            ...persistedRun,
            completedCount:
              persistedRun.completedCount + (input.nextStatus === "completed" ? 1 : 0),
            skippedCount: persistedRun.skippedCount + (input.nextStatus === "skipped" ? 1 : 0),
            failedCount: persistedRun.failedCount + (input.nextStatus === "failed" ? 1 : 0),
          };
          return true;
        }),
      selectNextPage: () =>
        Effect.succeed(
          page++ === 0 ? [{ threadId, lastActivityAt: "2026-08-10T00:00:00.000Z" }] : [],
        ),
      getPolicyAuthority: () => Effect.succeed(Option.some({ policy: "7-days" })),
    } as never;
    let page = 0;
    let deleted = false;
    let itemStatus: ThreadRetentionRunItem["status"] = "deletion_requested";
    const dispatch = vi.fn(() =>
      Effect.sync(() => {
        deleted = true;
        return { sequence: 1 };
      }),
    );
    const orchestration = {
      dispatch,
      streamDomainEvents: Stream.empty,
      getReadModel: () =>
        Effect.succeed({
          threads: deleted ? [] : [{ id: threadId, deletedAt: null, parentThread: undefined }],
        } as never),
    } as never;
    const runtime = ManagedRuntime.make(
      ThreadRetentionLive.pipe(
        Layer.provideMerge(Layer.succeed(ThreadRetentionRepository, repository)),
        Layer.provideMerge(Layer.succeed(OrchestrationEngineService, orchestration)),
        Layer.provideMerge(ServerSettingsService.layerTest()),
      ),
    );
    const retention = await runtime.runPromise(Effect.service(ThreadRetention));
    const handlers = makeThreadRetentionWsRpcHandlers({
      threadRetention: retention,
    } as unknown as WsRpcContext);
    const issued = await runtime.runPromise(
      handlers[WS_METHODS.serverPreviewThreadRetention]({ trigger: "manual", policy: "7-days" }),
    );
    expect(issued.challenge).toEqual(
      expect.objectContaining({ token: challengeToken, policy: "7-days", singleUse: true }),
    );
    const result = await runtime.runPromise(
      handlers[WS_METHODS.serverStartThreadRetention]({ challengeToken }),
    );
    await runtime.dispose();

    expect(result.policy).toBe("7-days");
    expect(result.cutoffAt).toBe(issued.challenge.cutoffAt);
    expect(result.deletedCount).toBe(1);
    expect(consumeChallengeAndCreateRun).toHaveBeenCalledWith({
      token: challengeToken,
      trigger: "manual",
      runId: expect.any(String),
      consumedAt: expect.any(String),
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.retention-delete",
        threadId,
        cutoffAt: issued.challenge.cutoffAt,
      }),
    );
  });

  it("claims a retention run item then dispatches thread.retention-delete", async () => {
    const threadId = ThreadId.makeUnsafe("retention-thread");
    let deleted = false;
    const dispatch = vi.fn(() =>
      Effect.sync(() => {
        deleted = true;
        return { sequence: 1 };
      }),
    );
    const insertSelectedPage = vi.fn(() =>
      Effect.succeed({ applied: true, insertedCount: 1, outstandingBacklogCount: 1 }),
    );
    const transitionRun = vi.fn(() => Effect.succeed(true));
    const deleteNow = vi.fn();
    let page = 0;

    const result = await Effect.runPromise(
      runDirectThreadRetention({
        run: retentionRun,
        now: () => Date.parse("2026-08-18T00:00:00.000Z"),
        repository: runnerRepository(retentionRun, {
          insertSelectedPage,
          transitionRun,
          selectNextPage: () =>
            Effect.succeed(
              page++ === 0 ? [{ threadId, lastActivityAt: "2026-08-16T00:00:00.000Z" }] : [],
            ),
        }),
        orchestration: {
          dispatch,
          streamDomainEvents: Stream.empty,
          getReadModel: () =>
            Effect.succeed({
              threads: deleted ? [] : [{ id: threadId, deletedAt: null, parentThread: undefined }],
            } as never),
          threadDeletion: { deleteNow },
        } as never,
      }),
    );

    expect(insertSelectedPage).toHaveBeenCalledWith(
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
        run: { ...retentionRun, policy: "14-days", cutoffAt },
        now: () => Date.parse("2026-08-18T00:00:00.000Z"),
        repository: runnerRepository(
          { ...retentionRun, policy: "14-days", cutoffAt },
          {
            selectNextPage: (input: { readonly cutoffAt: string }) => {
              calls += 1;
              return calls === 1 ? selectNextPage(input) : Effect.succeed([]);
            },
          },
        ),
        orchestration: {
          dispatch: () => Effect.succeed({ sequence: 1 }),
          streamDomainEvents: Stream.empty,
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
        run: retentionRun,
        now: () => Date.parse("2026-08-18T00:00:00.000Z"),
        settleTimeoutMs: 0,
        repository: runnerRepository(retentionRun, {
          transitionRun,
          selectNextPage: () =>
            Effect.succeed(
              page++ === 0 ? [{ threadId, lastActivityAt: "2026-08-16T00:00:00.000Z" }] : [],
            ),
        }),
        orchestration: {
          dispatch: () => Effect.succeed({ sequence: 1 }),
          streamDomainEvents: Stream.empty,
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

  it("does not treat a not-yet-requested delete as skipped", async () => {
    const threadId = ThreadId.makeUnsafe("retention-idle-thread");
    let page = 0;

    const result = await Effect.runPromise(
      runDirectThreadRetention({
        run: retentionRun,
        now: () => Date.parse("2026-08-18T00:00:00.000Z"),
        settleTimeoutMs: 0,
        repository: runnerRepository(retentionRun, {
          selectNextPage: () =>
            Effect.succeed(
              page++ === 0 ? [{ threadId, lastActivityAt: "2026-08-16T00:00:00.000Z" }] : [],
            ),
        }),
        orchestration: {
          dispatch: () => Effect.succeed({ sequence: 1 }),
          streamDomainEvents: Stream.empty,
          getReadModel: () =>
            Effect.succeed({
              threads: [
                {
                  id: threadId,
                  deletedAt: null,
                  deletingAt: null,
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
  });

  it("counts a delete as skipped after deletingAt clears", async () => {
    const threadId = ThreadId.makeUnsafe("retention-skipped-thread");
    let page = 0;
    let reads = 0;

    const result = await Effect.runPromise(
      runDirectThreadRetention({
        run: retentionRun,
        now: () => Date.parse("2026-08-18T00:00:00.000Z"),
        settleTimeoutMs: 1_000,
        repository: runnerRepository(retentionRun, {
          selectNextPage: () =>
            Effect.succeed(
              page++ === 0 ? [{ threadId, lastActivityAt: "2026-08-16T00:00:00.000Z" }] : [],
            ),
        }),
        orchestration: {
          dispatch: () => Effect.succeed({ sequence: 1 }),
          streamDomainEvents: Stream.succeed({ type: "thread.deletion-failed" } as never),
          getReadModel: () =>
            Effect.sync(() => {
              reads += 1;
              return {
                threads: [
                  {
                    id: threadId,
                    deletedAt: null,
                    deletingAt: reads <= 2 ? "2026-08-18T00:00:00.000Z" : null,
                    parentThread: undefined,
                  },
                ],
              };
            }) as never,
        } as never,
      }),
    );

    expect(result.deletedCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(result.pendingCount).toBe(0);
  });
});
