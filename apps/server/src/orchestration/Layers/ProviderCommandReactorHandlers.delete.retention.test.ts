import { CommandId, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import { vi } from "vitest";

import { BrowserManager } from "../../browser/Services/BrowserManager.ts";
import { EntityPurge } from "../../deletion/Services/EntityPurge.ts";
import { ThreadRetentionRepository } from "../../persistence/Services/ThreadRetentionRepository.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { makeProcessDeletionRequested } from "./ProviderCommandReactorHandlers.delete.ts";

it.effect("cleans up and finalizes committed retention deletion without aborting", () => {
  const dispatched: Array<string> = [];
  const dispatch = vi.fn((command: { readonly type: string }) =>
    Effect.sync(() => {
      dispatched.push(command.type);
      return { sequence: 11 } as never;
    }),
  );
  const stopSession = vi.fn(() => Effect.void);
  const requestThread = vi.fn(() => Effect.succeed({ jobId: "retention-purge" } as never));
  const markPrepared = vi.fn(() => Effect.succeed(true));
  const threadId = ThreadId.makeUnsafe("retention-live-thread");
  const occurredAt = "2026-08-04T00:00:00.000Z";
  return Effect.gen(function* () {
    const processDeletion = yield* makeProcessDeletionRequested;

    yield* processDeletion(
      {
        resolveThread: () =>
          Effect.succeed({
            id: threadId,
            deletedAt: null,
            deletingAt: occurredAt,
            session: null,
          } as never),
        setThreadSession: () => Effect.void,
      },
      {
        eventId: "event-retention-live" as never,
        sequence: 1,
        aggregateKind: "thread",
        aggregateId: threadId,
        causationEventId: null,
        correlationId: null,
        commandId: CommandId.makeUnsafe("retention-delete-command"),
        occurredAt,
        metadata: {},
        type: "thread.deletion-requested",
        payload: { threadId, deletingAt: occurredAt },
      },
    );

    assert.equal(stopSession.mock.calls.length, 1);
    assert.equal(requestThread.mock.calls.length, 1);
    assert.deepEqual(dispatched, ["thread.delete.finalize"]);
    assert.equal(markPrepared.mock.calls.length, 1);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(OrchestrationEngineService)({
          dispatch,
          getReadModel: () => Effect.die("unused"),
          readEvents: () => Stream.empty,
          readReplay: () => Effect.die("unused"),
          streamDomainEvents: Stream.empty,
        }),
        Layer.mock(ProviderService)({
          listSessions: () =>
            Effect.succeed([
              {
                threadId: ThreadId.makeUnsafe("retention-live-thread"),
                provider: "codex",
                runtimeMode: "full-access",
                status: "ready",
                lastError: null,
              } as never,
            ]),
          stopSession,
          streamEvents: Stream.empty,
        }),
        Layer.mock(BrowserManager)({
          close: () => Effect.void,
          hasContext: () => Effect.succeed(false),
        }),
        Layer.mock(TerminalManager)({
          close: () => Effect.void,
          hasActiveThread: () => Effect.succeed(false),
        }),
        Layer.mock(EntityPurge)({ requestThread }),
        Layer.mock(ThreadRetentionRepository)({
          findItemByDeletionCommandId: () =>
            Effect.succeed(
              Option.some({
                runId: "retention-run",
                threadId: ThreadId.makeUnsafe("retention-live-thread"),
                expectedLastActivityAt: occurredAt,
                deletionCommandId: "retention-delete-command",
                purgeJobId: null,
                status: "deletion_requested",
                exclusionReason: null,
                attemptCount: 1,
                nextAttemptAt: null,
                lastErrorCode: null,
                createdAt: occurredAt,
                updatedAt: occurredAt,
                completedAt: null,
              }),
            ),
          recordRequiredBaselineSequence: () => Effect.succeed(true),
          markPrepared,
        }),
      ),
    ),
  );
});

it.effect("keeps cleanup failure retryable without aborting or terminal failure", () => {
  const recordItemRetry = vi.fn(() => Effect.succeed(true));
  const threadId = ThreadId.makeUnsafe("retention-cleanup-retry");
  const occurredAt = "2026-08-04T00:00:00.000Z";
  return Effect.gen(function* () {
    const processDeletion = yield* makeProcessDeletionRequested;
    yield* processDeletion(
      {
        resolveThread: () =>
          Effect.succeed({
            id: threadId,
            deletedAt: null,
            deletingAt: occurredAt,
            session: null,
          } as never),
        setThreadSession: () => Effect.void,
      },
      {
        eventId: "event-cleanup-retry" as never,
        sequence: 1,
        aggregateKind: "thread",
        aggregateId: threadId,
        causationEventId: null,
        correlationId: null,
        commandId: CommandId.makeUnsafe("retention-cleanup-command"),
        occurredAt,
        metadata: {},
        type: "thread.deletion-requested",
        payload: { threadId, deletingAt: occurredAt },
      },
    );

    assert.equal(recordItemRetry.mock.calls.length, 1);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(OrchestrationEngineService)({
          dispatch: () => Effect.die("must not abort or finalize"),
          getReadModel: () => Effect.die("unused"),
          readEvents: () => Stream.empty,
          readReplay: () => Effect.die("unused"),
          streamDomainEvents: Stream.empty,
        }),
        Layer.mock(ProviderService)({
          listSessions: () => Effect.succeed([{ threadId, status: "ready" } as never]),
          stopSession: () => Effect.fail(new Error("transient cleanup failure") as never),
          streamEvents: Stream.empty,
        }),
        Layer.mock(BrowserManager)({ close: () => Effect.void }),
        Layer.mock(TerminalManager)({ close: () => Effect.void }),
        Layer.mock(EntityPurge)({ requestThread: () => Effect.die("must not request purge") }),
        Layer.mock(ThreadRetentionRepository)({
          findItemByDeletionCommandId: () =>
            Effect.succeed(
              Option.some({ runId: "retention-run", threadId, attemptCount: 1 } as never),
            ),
          recordItemRetry,
        }),
      ),
    ),
  );
});

it.effect("persists the finalize baseline before marking retention purge prepared", () => {
  const operations: Array<string> = [];
  const occurredAt = "2026-08-04T00:00:00.000Z";
  const threadId = ThreadId.makeUnsafe("retention-finalize-thread");
  return Effect.gen(function* () {
    const processDeletion = yield* makeProcessDeletionRequested;
    yield* processDeletion(
      {
        resolveThread: () =>
          Effect.succeed({
            id: threadId,
            deletedAt: null,
            deletingAt: occurredAt,
            session: null,
          } as never),
        setThreadSession: () => Effect.die("unused"),
      },
      {
        eventId: "event-retention-finalize" as never,
        sequence: 1,
        aggregateKind: "thread",
        aggregateId: threadId,
        causationEventId: null,
        correlationId: null,
        commandId: CommandId.makeUnsafe("retention-finalize-command"),
        occurredAt,
        metadata: {},
        type: "thread.deletion-requested",
        payload: { threadId, deletingAt: occurredAt },
      },
    );

    assert.deepEqual(operations, ["request", "finalize", "baseline:42", "prepared"]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command: { readonly type: string }) =>
            Effect.sync(() => {
              if (command.type === "thread.delete.finalize") operations.push("finalize");
              return { sequence: 42 } as never;
            }),
          getReadModel: () => Effect.die("unused"),
          readEvents: () => Stream.empty,
          readReplay: () => Effect.die("unused"),
          streamDomainEvents: Stream.empty,
        }),
        Layer.mock(ProviderService)({
          listSessions: () => Effect.succeed([]),
          streamEvents: Stream.empty,
        }),
        Layer.mock(BrowserManager)({
          close: () => Effect.void,
          hasContext: () => Effect.succeed(false),
        }),
        Layer.mock(TerminalManager)({
          close: () => Effect.void,
          hasActiveThread: () => Effect.succeed(false),
        }),
        Layer.mock(EntityPurge)({
          requestThread: () =>
            Effect.sync(() => {
              operations.push("request");
              return { jobId: "purge-job" } as never;
            }),
        }),
        Layer.mock(ThreadRetentionRepository)({
          findItemByDeletionCommandId: () =>
            Effect.succeed(
              Option.some({
                runId: "retention-run",
                threadId,
                status: "deletion_requested",
              } as never),
            ),
          recordRequiredBaselineSequence: (input) =>
            Effect.sync(() => {
              operations.push(`baseline:${input.sequence}`);
              return true;
            }),
          markPrepared: () =>
            Effect.sync(() => {
              operations.push("prepared");
              return true;
            }),
        }),
      ),
    ),
  );
});
