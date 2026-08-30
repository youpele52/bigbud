import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ThreadRetentionRun,
  ThreadRetentionRunItem,
  ThreadRetentionRepository,
  isThreadRetentionTerminalRunStatus,
  type ThreadRetentionRepositoryShape,
  type TransitionRetentionItemInput,
} from "../Services/ThreadRetentionRepository.ts";
import { makeThreadRetentionChallenges } from "./ThreadRetentionRepository.challenges.ts";
import { makeThreadRetentionAudit } from "./ThreadRetentionRepository.audit.ts";
import { makeThreadRetentionClaim } from "./ThreadRetentionRepository.claim.ts";
import { makeThreadRetentionPages } from "./ThreadRetentionRepository.pages.ts";
import { makeThreadRetentionPreview } from "./ThreadRetentionRepository.preview.ts";
import { makeThreadRetentionQueue } from "./ThreadRetentionRepository.queue.ts";
import { makeThreadRetentionRetry } from "./ThreadRetentionRepository.retry.ts";

const clampLimit = (limit: number, maximum = 100) =>
  Math.max(1, Math.min(maximum, Math.floor(limit)));
const mapPersistenceError = (operation: string) =>
  Effect.mapError(toPersistenceSqlError(`ThreadRetentionRepository.${operation}`));

const makeThreadRetentionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getRunQuery = (runId: string) =>
    sql<ThreadRetentionRun>`
      SELECT run_id AS "runId", trigger_kind AS trigger, policy, cutoff_at AS "cutoffAt", status,
        cursor_last_activity_at AS "cursorLastActivityAt", cursor_thread_id AS "cursorThreadId",
        eligible_count AS "eligibleCount", selected_count AS "selectedCount",
        skipped_count AS "skippedCount", requested_count AS "requestedCount",
        completed_count AS "completedCount", failed_count AS "failedCount",
        estimated_resource_count AS "estimatedResourceCount",
        required_baseline_sequence AS "requiredBaselineSequence", next_attempt_at AS "nextAttemptAt",
        last_error_code AS "lastErrorCode", retry_ordinal AS "retryOrdinal",
        failure_window_started_at AS "failureWindowStartedAt",
        failure_count_in_window AS "failureCountInWindow", last_failure_at AS "lastFailureAt",
        circuit_open_until AS "circuitOpenUntil", created_at AS "createdAt", started_at AS "startedAt",
        updated_at AS "updatedAt", completed_at AS "completedAt"
      FROM thread_retention_runs WHERE run_id = ${runId}
    `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));
  const findItemQuery = (deletionCommandId: string) =>
    sql<ThreadRetentionRunItem>`
      SELECT run_id AS "runId", thread_id AS "threadId",
        expected_last_activity_at AS "expectedLastActivityAt",
        deletion_command_id AS "deletionCommandId", purge_job_id AS "purgeJobId", status,
        exclusion_reason AS "exclusionReason", attempt_count AS "attemptCount",
        next_attempt_at AS "nextAttemptAt",
        last_error_code AS "lastErrorCode", created_at AS "createdAt", updated_at AS "updatedAt",
        completed_at AS "completedAt"
      FROM thread_retention_run_items WHERE deletion_command_id = ${deletionCommandId}
    `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));
  const listRunItems = (runId: string) => sql<ThreadRetentionRunItem>`
    SELECT run_id AS "runId", thread_id AS "threadId",
      expected_last_activity_at AS "expectedLastActivityAt",
      deletion_command_id AS "deletionCommandId", purge_job_id AS "purgeJobId", status,
      exclusion_reason AS "exclusionReason", attempt_count AS "attemptCount",
      next_attempt_at AS "nextAttemptAt",
      last_error_code AS "lastErrorCode", created_at AS "createdAt", updated_at AS "updatedAt",
      completed_at AS "completedAt"
    FROM thread_retention_run_items WHERE run_id = ${runId}
    ORDER BY expected_last_activity_at ASC, thread_id ASC
  `;
  const listOutstandingItems = (runId: string, limit: number) => sql<ThreadRetentionRunItem>`
    SELECT run_id AS "runId", thread_id AS "threadId",
      expected_last_activity_at AS "expectedLastActivityAt",
      deletion_command_id AS "deletionCommandId", purge_job_id AS "purgeJobId", status,
      exclusion_reason AS "exclusionReason", attempt_count AS "attemptCount",
      next_attempt_at AS "nextAttemptAt",
      last_error_code AS "lastErrorCode", created_at AS "createdAt", updated_at AS "updatedAt",
      completed_at AS "completedAt"
    FROM thread_retention_run_items WHERE run_id = ${runId}
      AND status IN ('selected', 'deletion_requested', 'prepared', 'purging')
    ORDER BY expected_last_activity_at ASC, thread_id ASC LIMIT ${clampLimit(limit, 250)}
  `;
  const listDeletionOwnedThreadIds = (threadIds: ReadonlyArray<string>) => {
    const bounded = threadIds.slice(0, 250);
    if (bounded.length === 0) return Effect.succeed([] as ReadonlyArray<string>);
    return sql<{ readonly threadId: string }>`
      SELECT DISTINCT thread_id AS "threadId"
      FROM thread_retention_run_items
      WHERE thread_id IN ${sql.in(bounded)}
        AND status IN ('deletion_requested', 'prepared', 'purging')
    `.pipe(Effect.map((rows) => rows.map((row) => row.threadId)));
  };

  const transitionRun = (input: Parameters<ThreadRetentionRepositoryShape["transitionRun"]>[0]) => {
    if (input.expectedStatuses.length === 0) return Effect.succeed(false);
    const terminal = isThreadRetentionTerminalRunStatus(input.nextStatus);
    const hasCursor = input.cursor !== undefined;
    const hasNextAttempt = input.nextAttemptAt !== undefined;
    const hasError = input.lastErrorCode !== undefined;
    const hasEligibleCount = input.eligibleCount !== undefined;
    const hasEstimatedResources = input.estimatedResourceCount !== undefined;
    const hasRequiredSequence = input.requiredBaselineSequence !== undefined;
    return sql`
      UPDATE thread_retention_runs SET status = ${input.nextStatus},
        active_slot = ${terminal || input.releaseActiveSlot === true ? null : 1},
        cursor_last_activity_at = CASE WHEN ${hasCursor ? 1 : 0} = 1 THEN ${input.cursor?.lastActivityAt ?? null} ELSE cursor_last_activity_at END,
        cursor_thread_id = CASE WHEN ${hasCursor ? 1 : 0} = 1 THEN ${input.cursor?.threadId ?? null} ELSE cursor_thread_id END,
        next_attempt_at = CASE WHEN ${hasNextAttempt ? 1 : 0} = 1 THEN ${input.nextAttemptAt ?? null} ELSE next_attempt_at END,
        last_error_code = CASE WHEN ${hasError ? 1 : 0} = 1 THEN ${input.lastErrorCode ?? null} ELSE last_error_code END,
        eligible_count = CASE WHEN ${hasEligibleCount ? 1 : 0} = 1 THEN ${input.eligibleCount ?? 0} ELSE eligible_count END,
        estimated_resource_count = CASE WHEN ${hasEstimatedResources ? 1 : 0} = 1 THEN ${input.estimatedResourceCount ?? 0} ELSE estimated_resource_count END,
        required_baseline_sequence = CASE WHEN ${hasRequiredSequence ? 1 : 0} = 1 THEN ${input.requiredBaselineSequence ?? null} ELSE required_baseline_sequence END,
        started_at = CASE WHEN started_at IS NULL AND ${input.nextStatus} <> 'queued' THEN ${input.updatedAt} ELSE started_at END,
        completed_at = CASE WHEN ${terminal ? 1 : 0} = 1 THEN ${input.updatedAt} ELSE NULL END,
        updated_at = ${input.updatedAt}
      WHERE run_id = ${input.runId} AND status IN ${sql.in(input.expectedStatuses)}
        AND active_slot = 1
      RETURNING run_id
    `.pipe(Effect.map((rows) => rows.length === 1));
  };

  const transitionItem = Effect.fn("ThreadRetentionRepository.transitionItem")(function* (
    input: TransitionRetentionItemInput,
  ) {
    if (input.expectedStatuses.length === 0) return false;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const terminal = ["completed", "skipped", "failed"].includes(input.nextStatus);
        const rows = yield* sql`
          UPDATE thread_retention_run_items SET status = ${input.nextStatus},
            purge_job_id = COALESCE(${input.purgeJobId ?? null}, purge_job_id),
            exclusion_reason = ${input.exclusionReason ?? null}, last_error_code = ${input.lastErrorCode ?? null},
            next_attempt_at = NULL,
            attempt_count = attempt_count + 1, updated_at = ${input.updatedAt},
            completed_at = CASE WHEN ${terminal ? 1 : 0} = 1 THEN ${input.updatedAt} ELSE NULL END
          WHERE run_id = ${input.runId} AND thread_id = ${input.threadId}
            AND status IN ${sql.in(input.expectedStatuses)}
            AND EXISTS (
              SELECT 1 FROM thread_retention_runs AS run
              WHERE run.run_id = ${input.runId} AND run.active_slot = 1
            ) RETURNING run_id
        `;
        if (rows.length !== 1) return false;
        const counter =
          input.nextStatus === "completed"
            ? "completed_count"
            : input.nextStatus === "skipped"
              ? "skipped_count"
              : input.nextStatus === "failed"
                ? "failed_count"
                : null;
        if (counter !== null)
          yield* sql.unsafe(
            `UPDATE thread_retention_runs SET ${counter} = ${counter} + 1, updated_at = ? WHERE run_id = ? AND active_slot = 1`,
            [input.updatedAt, input.runId],
          );
        return true;
      }),
    );
  });

  const recordItemRetry = (
    input: Parameters<ThreadRetentionRepositoryShape["recordItemRetry"]>[0],
  ) => {
    if (input.expectedStatuses.length === 0) return Effect.succeed(false);
    return sql`
      UPDATE thread_retention_run_items SET attempt_count = attempt_count + 1,
        last_error_code = ${input.lastErrorCode}, next_attempt_at = ${input.nextAttemptAt},
        updated_at = ${input.updatedAt}
      WHERE run_id = ${input.runId} AND thread_id = ${input.threadId}
        AND status IN ${sql.in(input.expectedStatuses)}
        AND EXISTS (
          SELECT 1 FROM thread_retention_runs AS run
          WHERE run.run_id = ${input.runId} AND run.active_slot = 1
        )
      RETURNING thread_id
    `.pipe(Effect.map((rows) => rows.length === 1));
  };

  const listRuns = (where: "" | "active_slot = 1", limit: number) => sql<ThreadRetentionRun>`
    SELECT run_id AS "runId", trigger_kind AS trigger, policy, cutoff_at AS "cutoffAt", status,
      cursor_last_activity_at AS "cursorLastActivityAt", cursor_thread_id AS "cursorThreadId",
      eligible_count AS "eligibleCount", selected_count AS "selectedCount", skipped_count AS "skippedCount",
      requested_count AS "requestedCount", completed_count AS "completedCount", failed_count AS "failedCount",
      estimated_resource_count AS "estimatedResourceCount", required_baseline_sequence AS "requiredBaselineSequence",
      next_attempt_at AS "nextAttemptAt", last_error_code AS "lastErrorCode",
      retry_ordinal AS "retryOrdinal", failure_window_started_at AS "failureWindowStartedAt",
      failure_count_in_window AS "failureCountInWindow", last_failure_at AS "lastFailureAt",
      circuit_open_until AS "circuitOpenUntil", created_at AS "createdAt",
      started_at AS "startedAt", updated_at AS "updatedAt", completed_at AS "completedAt"
    FROM thread_retention_runs WHERE ${sql.unsafe(where === "" ? "1 = 1" : where)}
    ORDER BY
      CASE
        WHEN active_slot = 1 THEN 0
        WHEN trigger_kind = 'manual' AND status <> 'queued'
          AND status NOT IN ('completed', 'completed_with_failures', 'failed', 'cancelled') THEN 1
        WHEN trigger_kind = 'manual' AND status = 'queued' THEN 2
        WHEN trigger_kind = 'scheduled' AND status <> 'queued'
          AND status NOT IN ('completed', 'completed_with_failures', 'failed', 'cancelled') THEN 3
        WHEN status = 'queued' THEN 4
        ELSE 5
      END ASC,
      CASE WHEN status IN ('completed', 'completed_with_failures', 'failed', 'cancelled')
        THEN created_at END DESC,
      created_at ASC, run_id ASC
    LIMIT ${clampLimit(limit)}
  `;

  const queue = makeThreadRetentionQueue({ sql, getRun: getRunQuery });
  const challenges = makeThreadRetentionChallenges({
    sql,
    getRun: getRunQuery,
    createQueuedRun: queue.createQueuedRun,
  });
  const cleanupAudit = makeThreadRetentionAudit(sql);
  const pages = makeThreadRetentionPages(sql);
  const preview = makeThreadRetentionPreview(sql);
  const claim = makeThreadRetentionClaim(sql);
  const retry = makeThreadRetentionRetry(sql);
  const insertSelectedItems = ((
    input: Parameters<ThreadRetentionRepositoryShape["insertSelectedItems"]>[0],
  ) =>
    pages
      .insertSelectedItems(input)
      .pipe(
        mapPersistenceError("insertSelectedItems"),
      )) as ThreadRetentionRepositoryShape["insertSelectedItems"];

  return {
    listDeletionOwnedThreadIds: (threadIds) =>
      listDeletionOwnedThreadIds(threadIds).pipe(mapPersistenceError("listDeletionOwnedThreadIds")),
    preview: (cutoffAt) => preview(cutoffAt).pipe(mapPersistenceError("preview")),
    createOrGetActiveRun: (input) =>
      queue.createOrGetActiveRun(input).pipe(mapPersistenceError("createOrGetActiveRun")),
    createQueuedRun: (input) =>
      queue.createQueuedRun(input).pipe(mapPersistenceError("createQueuedRun")),
    createScheduledQueuedRun: (input) =>
      queue.createScheduledQueuedRun(input).pipe(mapPersistenceError("createScheduledQueuedRun")),
    claimNextQueuedRun: (claimedAt) =>
      queue.claimNextQueuedRun(claimedAt).pipe(mapPersistenceError("claimNextQueuedRun")),
    listQueuedManualRuns: (limit) =>
      queue.listQueuedManualRuns(limit).pipe(mapPersistenceError("listQueuedManualRuns")),
    claimQueuedManualRun: (runId, claimedAt, purgeBacklogLimit) =>
      queue
        .claimQueuedManualRun(runId, claimedAt, purgeBacklogLimit)
        .pipe(mapPersistenceError("claimQueuedManualRun")),
    yieldActiveRunToManual: (activeRunId, manualRunId, yieldedAt, purgeBacklogLimit) =>
      queue
        .yieldActiveRunToManual(activeRunId, manualRunId, yieldedAt, purgeBacklogLimit)
        .pipe(mapPersistenceError("yieldActiveRunToManual")),
    selectNextPage: (input) =>
      pages.selectNextPage(input).pipe(mapPersistenceError("selectNextPage")),
    insertSelectedItems,
    insertSelectedPage: (input) =>
      pages.insertSelectedPage(input).pipe(mapPersistenceError("insertSelectedPage")),
    recordRunFailure: (input) =>
      retry.recordRunFailure(input).pipe(mapPersistenceError("recordRunFailure")),
    readRunRetryState: (runId, now) =>
      retry.readRunRetryState(runId, now).pipe(mapPersistenceError("readRunRetryState")),
    clearRunRetryState: (input) =>
      retry.clearRunRetryState(input).pipe(mapPersistenceError("clearRunRetryState")),
    getRecentFailureSummary: (input) =>
      retry.getRecentFailureSummary(input).pipe(mapPersistenceError("getRecentFailureSummary")),
    countOutstandingItems: (runId) =>
      pages.countOutstandingItems(runId).pipe(mapPersistenceError("countOutstandingItems")),
    recordRequiredBaselineSequence: (input) =>
      sql`
        UPDATE thread_retention_runs SET required_baseline_sequence = CASE
          WHEN required_baseline_sequence IS NULL OR required_baseline_sequence < ${input.sequence}
          THEN ${input.sequence} ELSE required_baseline_sequence END,
          updated_at = ${input.updatedAt}
        WHERE run_id = ${input.runId} AND active_slot = 1 RETURNING run_id
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        mapPersistenceError("recordRequiredBaselineSequence"),
      ),
    recheckAndClaimItem: (input) =>
      claim.recheckAndClaimItem(input).pipe(mapPersistenceError("recheckAndClaimItem")),
    findItemByDeletionCommandId: (commandId) =>
      findItemQuery(commandId).pipe(mapPersistenceError("findItemByDeletionCommandId")),
    listRunItems: (runId) => listRunItems(runId).pipe(mapPersistenceError("listRunItems")),
    listOutstandingItems: (runId, limit) =>
      listOutstandingItems(runId, limit).pipe(mapPersistenceError("listOutstandingItems")),
    transitionRun: (input) => transitionRun(input).pipe(mapPersistenceError("transitionRun")),
    transitionItem: (input) => transitionItem(input).pipe(mapPersistenceError("transitionItem")),
    recordItemRetry: (input) => recordItemRetry(input).pipe(mapPersistenceError("recordItemRetry")),
    markPrepared: (input) =>
      transitionItem({
        ...input,
        expectedStatuses: ["deletion_requested"],
        nextStatus: "prepared",
        purgeJobId: input.purgeJobId,
      }).pipe(mapPersistenceError("markPrepared")),
    getRun: (runId) => getRunQuery(runId).pipe(mapPersistenceError("getRun")),
    listRecentRuns: (limit) => listRuns("", limit).pipe(mapPersistenceError("listRecentRuns")),
    listRecoverableRuns: (limit) =>
      listRuns("active_slot = 1", limit).pipe(mapPersistenceError("listRecoverableRuns")),
    cleanupAudit: (input) => cleanupAudit(input).pipe(mapPersistenceError("cleanupAudit")),
    issueChallenge: (input) =>
      challenges.issueChallenge(input).pipe(mapPersistenceError("issueChallenge")),
    consumeChallenge: (input) =>
      challenges.consumeChallenge(input).pipe(mapPersistenceError("consumeChallenge")),
    readChallenge: (token) =>
      challenges.readChallenge(token).pipe(mapPersistenceError("readChallenge")),
    consumeChallengeAndCreateRun: (input) =>
      challenges
        .consumeChallengeAndCreateRun(input)
        .pipe(mapPersistenceError("consumeChallengeAndCreateRun")),
    consumeManualChallenge: (input) =>
      challenges.consumeManualChallenge(input).pipe(mapPersistenceError("consumeManualChallenge")),
    getPolicyAuthority: () =>
      sql<import("../Services/ThreadRetentionRepository.ts").ThreadRetentionPolicyAuthority>`
        SELECT policy, source, updated_at AS "updatedAt"
        FROM thread_retention_policy_authority WHERE singleton_id = 1
      `.pipe(
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        mapPersistenceError("getPolicyAuthority"),
      ),
    setPolicyAuthority: (input) =>
      sql`
        INSERT INTO thread_retention_policy_authority (singleton_id, policy, source, updated_at)
        VALUES (1, ${input.policy}, ${input.source}, ${input.updatedAt})
        ON CONFLICT (singleton_id) DO UPDATE SET policy = excluded.policy,
          source = excluded.source, updated_at = excluded.updated_at
      `.pipe(Effect.asVoid, mapPersistenceError("setPolicyAuthority")),
    consumePolicyChallenge: (input) =>
      challenges.consumePolicyChallenge(input).pipe(mapPersistenceError("consumePolicyChallenge")),
  } satisfies ThreadRetentionRepositoryShape;
});

export const ThreadRetentionRepositoryLive = Layer.effect(
  ThreadRetentionRepository,
  makeThreadRetentionRepository,
);
