/**
 * ThreadBranchCopyLive - server-side branch copies.
 *
 * `start` fixes the branch point (the named message, or the newest settled one), counts what it
 * covers, records the job, creates the branch thread and returns; the copy runs in the
 * background. Each batch is one internal `thread.branch-copy.append` command with a
 * deterministic command id and deterministic message ids, and the job row advances only after
 * the batch is accepted. A replay after a crash therefore hits the command receipt, or failing
 * that upserts the same message rows: never a duplicate. Copies run one at a time.
 *
 * The source must stay live for the whole copy. If it is deleted, or messages before the branch
 * point disappear (a revert), the job fails and the branch's title says the copy is incomplete:
 * finishing from rows already read would leave a silently partial branch, and deletion purges
 * the rows the copy still needs.
 *
 * @module ThreadBranchCopyLive
 */
import type { OrchestrationCommand, ThreadId } from "@bigbud/contracts";
import {
  OrchestrationStartThreadBranchError,
  type StartThreadBranchInput,
  type ThreadBranchCopyStatus,
} from "@bigbud/contracts/orchestration/orchestration.branchCopy.ts";
import { Cause, Effect, Layer, Schema, Semaphore } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ThreadBranchCopy, type ThreadBranchCopyShape } from "../Services/ThreadBranchCopy.ts";
import {
  BRANCH_COPY_BATCH,
  branchCopyBatchSize,
  branchCopyCommandId,
  failedBranchTitle,
  toBranchMessage,
} from "../ThreadBranchCopy.logic.ts";
import { type BranchCopyJob, makeBranchCopySql } from "./ThreadBranchCopy.sql.ts";

type CreateCommand = Extract<OrchestrationCommand, { type: "thread.create" }>;

const nowIso = () => new Date().toISOString();

const toStatus = (job: BranchCopyJob): ThreadBranchCopyStatus => ({
  branchThreadId: job.branchThreadId as ThreadId,
  state: job.state,
  copiedMessages: job.copiedMessages,
  // Messages still streaming when the branch was requested may settle and be copied too.
  totalMessages: Math.max(job.totalMessages, job.copiedMessages),
  error: job.error,
});

const startError = (message: string, cause?: unknown) =>
  new OrchestrationStartThreadBranchError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });

class BranchCopyFailure extends Error {}

export const makeThreadBranchCopy = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngineService;
  const db = makeBranchCopySql(sql);
  const scope = yield* Effect.scope;
  const copySemaphore = yield* Semaphore.make(1);
  const running = new Set<string>();

  const markFailed = (job: BranchCopyJob, error: string) =>
    Effect.gen(function* () {
      yield* db.finishJob({
        branchThreadId: job.branchThreadId,
        state: "failed",
        error,
        now: nowIso(),
      });
      const create = JSON.parse(job.createInputJson) as CreateCommand;
      if (!(yield* db.threadExists(job.branchThreadId))) return;
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: branchCopyCommandId(create.threadId, "fail"),
        threadId: create.threadId,
        title: failedBranchTitle(create.title),
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not record a failed branch copy", {
          branchThreadId: job.branchThreadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const copyBatches = (branchThreadId: string) =>
    Effect.gen(function* () {
      const first = yield* db.getJob(branchThreadId);
      if (!first || first.state !== "copying") return;
      const create = JSON.parse(first.createInputJson) as CreateCommand;
      if (!(yield* db.threadExists(branchThreadId))) yield* engine.dispatch(create);
      while (true) {
        const job = yield* db.getJob(branchThreadId);
        if (!job || job.state !== "copying") return;
        if (!(yield* db.readLiveThread(job.sourceThreadId))) {
          return yield* Effect.fail(
            new BranchCopyFailure("The source thread was deleted before the copy finished."),
          );
        }
        const sizes = yield* db.readNextSizes({
          sourceThreadId: job.sourceThreadId,
          cursor: job.cursor,
          boundary: job.boundary,
          limit: BRANCH_COPY_BATCH.maxMessages,
        });
        if (sizes.length === 0) {
          yield* db.finishJob({ branchThreadId, state: "completed", error: null, now: nowIso() });
          return;
        }
        const picked = sizes.slice(0, branchCopyBatchSize(sizes.map((row) => row.textLength)));
        const rows = yield* db.readMessages(picked.map((row) => row.messageId));
        if (rows.length !== picked.length) {
          return yield* Effect.fail(
            new BranchCopyFailure("The source thread changed before the copy finished."),
          );
        }
        const last = picked[picked.length - 1]!;
        // The payload must be identical on replay: the command claim compares its digest.
        yield* engine.dispatch({
          type: "thread.branch-copy.append",
          commandId: branchCopyCommandId(create.threadId, job.nextBatch),
          threadId: create.threadId,
          messages: rows.map((row) => toBranchMessage(create.threadId, row)),
          createdAt: last.createdAt,
        });
        yield* db.advanceJob({
          branchThreadId,
          batch: job.nextBatch,
          cursor: { createdAt: last.createdAt, messageId: last.messageId },
          copied: rows.length,
          now: nowIso(),
        });
        yield* Effect.yieldNow;
      }
    });

  const runJob: ThreadBranchCopyShape["runJob"] = (branchThreadId) =>
    Effect.suspend(() => {
      if (running.has(branchThreadId)) return Effect.void;
      running.add(branchThreadId);
      return copySemaphore.withPermits(1)(
        copyBatches(branchThreadId).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const job = yield* db.getJob(branchThreadId);
              if (!job) return;
              const failure = Cause.squash(cause);
              yield* markFailed(
                job,
                failure instanceof BranchCopyFailure
                  ? failure.message
                  : "The branch copy stopped on an error. Try branching again.",
              );
              yield* Effect.logWarning("branch copy failed", {
                branchThreadId,
                cause: Cause.pretty(cause),
              });
            }).pipe(Effect.catchCause(() => Effect.void)),
          ),
          Effect.ensuring(Effect.sync(() => running.delete(branchThreadId))),
        ),
      );
    });

  const start: ThreadBranchCopyShape["start"] = Effect.fn("ThreadBranchCopy.start")(
    function* (input: StartThreadBranchInput) {
      const existing = yield* db.getJob(input.branchThreadId);
      if (existing) return toStatus(existing);
      const source = yield* db.readLiveThread(input.sourceThreadId);
      if (!source) return yield* startError("Source thread not found.");
      if (yield* db.threadExists(input.branchThreadId)) {
        return yield* startError("The branch thread already exists.");
      }
      const boundary = yield* db.readBoundary(input.sourceThreadId, input.upToMessageId);
      if (!boundary) {
        return yield* startError(
          input.upToMessageId === null
            ? "No messages to copy into the branched thread."
            : "Branch point message not found.",
        );
      }
      if (boundary.isStreaming) {
        return yield* startError("Wait for the message to finish before branching.");
      }
      const totalMessages = yield* db.countThrough(input.sourceThreadId, boundary);
      const create: CreateCommand = {
        type: "thread.create",
        commandId: branchCopyCommandId(input.branchThreadId, "create"),
        threadId: input.branchThreadId,
        projectId: source.projectId as CreateCommand["projectId"],
        title: input.title,
        ...(input.providerRuntimeExecutionTargetId !== undefined
          ? { providerRuntimeExecutionTargetId: input.providerRuntimeExecutionTargetId }
          : {}),
        ...(input.workspaceExecutionTargetId !== undefined
          ? { workspaceExecutionTargetId: input.workspaceExecutionTargetId }
          : {}),
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch: input.branch,
        worktreePath: input.worktreePath,
        createdAt: input.createdAt,
      };
      yield* db.insertJob({
        branchThreadId: input.branchThreadId,
        sourceThreadId: input.sourceThreadId,
        createInputJson: JSON.stringify(create),
        boundary: { createdAt: boundary.createdAt, messageId: boundary.messageId },
        totalMessages,
        now: nowIso(),
      });
      // Created before returning, so an invalid request fails here and the client can open it.
      yield* engine.dispatch(create).pipe(
        Effect.tapError((error) =>
          db.finishJob({
            branchThreadId: input.branchThreadId,
            state: "failed",
            error: error.message,
            now: nowIso(),
          }),
        ),
      );
      yield* Effect.forkIn(runJob(input.branchThreadId), scope);
      const job = yield* db.getJob(input.branchThreadId);
      if (!job) return yield* startError("The branch copy was not recorded.");
      return toStatus(job);
    },
    (effect) =>
      effect.pipe(
        Effect.mapError((error) =>
          Schema.is(OrchestrationStartThreadBranchError)(error)
            ? error
            : startError(
                "message" in error && typeof error.message === "string" && error.message
                  ? error.message
                  : "Could not start the branch.",
                error,
              ),
        ),
      ),
  );

  const status: ThreadBranchCopyShape["status"] = (branchThreadId) =>
    db.getJob(branchThreadId).pipe(
      Effect.map((job) => (job ? toStatus(job) : null)),
      Effect.mapError(toPersistenceSqlError("ThreadBranchCopy.status")),
    );

  // Copies that were running when the server stopped continue from their recorded batch.
  yield* db.listCopyingJobIds.pipe(
    Effect.flatMap((ids) => Effect.forEach(ids, (id) => runJob(id as ThreadId), { discard: true })),
    Effect.catchCause((cause) =>
      Effect.logWarning("could not resume branch copies", { cause: Cause.pretty(cause) }),
    ),
    Effect.forkIn(scope),
  );

  return { start, status, runJob } satisfies ThreadBranchCopyShape;
});

export const ThreadBranchCopyLive = Layer.effect(ThreadBranchCopy, makeThreadBranchCopy);
