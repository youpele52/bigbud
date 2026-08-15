import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type {
  CreateRetentionRunInput,
  ThreadRetentionRun,
} from "../Services/ThreadRetentionRepository.ts";
import { THREAD_RETENTION_NONTERMINAL_RUN_STATUSES } from "../Services/ThreadRetentionRepository.ts";
import { PURGE_MAX_ATTEMPTS } from "../Services/PurgeJobRepository.ts";
import { retentionDurableExclusions } from "./ThreadRetentionRepository.eligibility.ts";

export function makeThreadRetentionQueue<E, R>(input: {
  readonly sql: SqlClient.SqlClient;
  readonly getRun: (runId: string) => Effect.Effect<Option.Option<ThreadRetentionRun>, E, R>;
}) {
  const eligible = retentionDurableExclusions(input.sql);

  const createQueuedRun = Effect.fn("ThreadRetentionRepository.createQueuedRun")(function* (
    runInput: CreateRetentionRunInput,
  ) {
    yield* input.sql`
      INSERT INTO thread_retention_runs (
        run_id, trigger_kind, policy, cutoff_at, status, active_slot, eligible_count,
        created_at, updated_at
      ) VALUES (${runInput.runId}, ${runInput.trigger}, ${runInput.policy}, ${runInput.cutoffAt},
        'queued', NULL,
        (SELECT COUNT(*) FROM projection_threads AS t
          WHERE t.last_activity_at <= ${runInput.cutoffAt} AND ${eligible}),
        ${runInput.createdAt}, ${runInput.createdAt})
      ON CONFLICT DO NOTHING
    `;
    const run = yield* input.getRun(runInput.runId);
    if (Option.isNone(run)) return yield* Effect.die("queued retention run was not persisted");
    return run.value;
  });

  const claimNextQueuedRun = Effect.fn("ThreadRetentionRepository.claimNextQueuedRun")(function* (
    claimedAt: string,
  ) {
    return yield* input.sql.withTransaction(
      Effect.gen(function* () {
        const active = yield* input.sql`
          SELECT run_id FROM thread_retention_runs WHERE active_slot = 1 LIMIT 1
        `;
        if (active.length > 0) return Option.none();
        const queued = yield* input.sql<{
          runId: string;
        }>`
          SELECT run_id AS "runId"
          FROM thread_retention_runs
          WHERE active_slot IS NULL
            AND status IN ${input.sql.in(THREAD_RETENTION_NONTERMINAL_RUN_STATUSES)}
            AND (next_attempt_at IS NULL OR next_attempt_at <= ${claimedAt})
          ORDER BY
            CASE
              WHEN trigger_kind = 'manual' THEN 0
              WHEN status <> 'queued' THEN 1
              ELSE 2
            END ASC,
            created_at ASC, run_id ASC
        `;
        const selected = queued[0];
        if (selected === undefined) return Option.none();
        const rows = yield* input.sql<{ runId: string }>`
          UPDATE thread_retention_runs SET active_slot = 1, updated_at = ${claimedAt}
          WHERE run_id = ${selected.runId} AND active_slot IS NULL
            AND status IN ${input.sql.in(THREAD_RETENTION_NONTERMINAL_RUN_STATUSES)}
            AND (next_attempt_at IS NULL OR next_attempt_at <= ${claimedAt})
          AND NOT EXISTS (
            SELECT 1 FROM thread_retention_runs WHERE active_slot = 1
          )
          RETURNING run_id AS "runId"
        `;
        const runId = rows[0]?.runId;
        return runId === undefined ? Option.none() : yield* input.getRun(runId);
      }),
    );
  });

  const claimQueuedManualRun = Effect.fn("ThreadRetentionRepository.claimQueuedManualRun")(
    function* (runId: string, claimedAt: string, purgeBacklogLimit: number) {
      return yield* input.sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* input.sql<{ runId: string }>`
            UPDATE thread_retention_runs SET active_slot = 1, updated_at = ${claimedAt}
            WHERE run_id = ${runId} AND trigger_kind = 'manual'
              AND status IN ${input.sql.in(THREAD_RETENTION_NONTERMINAL_RUN_STATUSES)}
              AND active_slot IS NULL
              AND (next_attempt_at IS NULL OR next_attempt_at <= ${claimedAt})
              AND NOT EXISTS (
                SELECT 1 FROM thread_retention_runs WHERE active_slot = 1
              )
              AND (
                SELECT COUNT(*) FROM purge_jobs
                WHERE status <> 'completed' AND auto_resume_disabled = 0
                  AND attempt_count < ${PURGE_MAX_ATTEMPTS}
              ) < ${purgeBacklogLimit}
            RETURNING run_id AS "runId"
          `;
          const claimedRunId = rows[0]?.runId;
          return claimedRunId === undefined ? Option.none() : yield* input.getRun(claimedRunId);
        }),
      );
    },
  );

  const listQueuedManualRuns = Effect.fn("ThreadRetentionRepository.listQueuedManualRuns")(
    function* (limit: number) {
      const rows = yield* input.sql<{ runId: string }>`
        SELECT run_id AS "runId"
        FROM thread_retention_runs
        WHERE trigger_kind = 'manual'
          AND active_slot IS NULL
          AND status IN ${input.sql.in(THREAD_RETENTION_NONTERMINAL_RUN_STATUSES)}
        ORDER BY created_at ASC, run_id ASC
        LIMIT ${Math.max(1, limit)}
      `;
      const runs = yield* Effect.forEach(rows, ({ runId }) => input.getRun(runId));
      return runs.flatMap((run) => (Option.isSome(run) ? [run.value] : []));
    },
  );

  const yieldActiveRunToManual = Effect.fn("ThreadRetentionRepository.yieldActiveRunToManual")(
    function* (
      activeRunId: string,
      manualRunId: string,
      yieldedAt: string,
      purgeBacklogLimit: number,
    ) {
      return yield* input.sql.withTransaction(
        Effect.gen(function* () {
          const manual = yield* input.sql<{ runId: string }>`
            SELECT run_id AS "runId" FROM thread_retention_runs
            WHERE run_id = ${manualRunId} AND trigger_kind = 'manual'
              AND status IN ${input.sql.in(THREAD_RETENTION_NONTERMINAL_RUN_STATUSES)}
              AND active_slot IS NULL
              AND (next_attempt_at IS NULL OR next_attempt_at <= ${yieldedAt})
              AND (
                SELECT COUNT(*) FROM purge_jobs
                WHERE status <> 'completed' AND auto_resume_disabled = 0
                  AND attempt_count < ${PURGE_MAX_ATTEMPTS}
              ) < ${purgeBacklogLimit}
            LIMIT 1
          `;
          if (manual.length === 0) return Option.none();
          const active = yield* input.sql<{ status: string }>`
            SELECT status FROM thread_retention_runs
            WHERE run_id = ${activeRunId} AND trigger_kind = 'scheduled' AND active_slot = 1
              AND status IN ${input.sql.in(THREAD_RETENTION_NONTERMINAL_RUN_STATUSES)}
            LIMIT 1
          `;
          if (active[0] === undefined) return Option.none();
          const yielded =
            active[0].status === "deferred"
              ? yield* input.sql`
                  UPDATE thread_retention_runs SET active_slot = NULL,
                    next_attempt_at = CASE
                      WHEN last_error_code IN (
                        'cleanup_failed', 'preparation_pending', 'purge_deferred',
                        'coordinator_failure', 'recent_failures', 'item_retry'
                      ) THEN next_attempt_at ELSE NULL END,
                    updated_at = ${yieldedAt}
                  WHERE run_id = ${activeRunId} AND status = 'deferred' AND active_slot = 1
                  RETURNING run_id
                `
              : yield* input.sql`
                  UPDATE thread_retention_runs SET status = 'deferred', active_slot = NULL,
                    next_attempt_at = CASE
                      WHEN last_error_code IN (
                        'cleanup_failed', 'preparation_pending', 'purge_deferred',
                        'coordinator_failure', 'recent_failures', 'item_retry'
                      ) THEN next_attempt_at ELSE NULL END,
                    updated_at = ${yieldedAt}
                  WHERE run_id = ${activeRunId} AND trigger_kind = 'scheduled' AND active_slot = 1
                    AND status IN ${input.sql.in(THREAD_RETENTION_NONTERMINAL_RUN_STATUSES)}
                  RETURNING run_id
                `;
          if (yielded.length !== 1) return Option.none();
          const claimed = yield* input.sql<{ runId: string }>`
            UPDATE thread_retention_runs SET active_slot = 1, updated_at = ${yieldedAt}
            WHERE run_id = ${manualRunId} AND trigger_kind = 'manual'
              AND status IN ${input.sql.in(THREAD_RETENTION_NONTERMINAL_RUN_STATUSES)}
              AND active_slot IS NULL
              AND (next_attempt_at IS NULL OR next_attempt_at <= ${yieldedAt})
              AND NOT EXISTS (SELECT 1 FROM thread_retention_runs WHERE active_slot = 1)
            RETURNING run_id AS "runId"
          `;
          const claimedRunId = claimed[0]?.runId;
          if (claimedRunId !== undefined) return yield* input.getRun(claimedRunId);
          return yield* Effect.die("retention manual handoff claim lost");
        }),
      );
    },
  );

  const createOrGetActiveRun = Effect.fn("ThreadRetentionRepository.createOrGetActiveRun")(
    function* (runInput: CreateRetentionRunInput) {
      return yield* input.sql.withTransaction(
        Effect.gen(function* () {
          const run = yield* createQueuedRun(runInput);
          yield* claimNextQueuedRun(runInput.createdAt);
          return run;
        }),
      );
    },
  );

  const createScheduledQueuedRun = Effect.fn("ThreadRetentionRepository.createScheduledQueuedRun")(
    function* (runInput: CreateRetentionRunInput & { readonly trigger: "scheduled" }) {
      return yield* input.sql.withTransaction(
        Effect.gen(function* () {
          const pending = yield* input.sql<{ runId: string }>`
            SELECT run_id AS "runId" FROM thread_retention_runs
            WHERE trigger_kind = 'scheduled' AND policy = ${runInput.policy}
              AND status NOT IN ('completed', 'completed_with_failures', 'failed', 'cancelled')
            ORDER BY rowid ASC LIMIT 1
          `;
          const pendingRunId = pending[0]?.runId;
          if (pendingRunId !== undefined) {
            const run = yield* input.getRun(pendingRunId);
            if (Option.isNone(run)) return yield* Effect.die("scheduled retention run disappeared");
            return { run: run.value, created: false } as const;
          }
          return { run: yield* createQueuedRun(runInput), created: true } as const;
        }),
      );
    },
  );

  return {
    createOrGetActiveRun,
    createQueuedRun,
    createScheduledQueuedRun,
    claimNextQueuedRun,
    listQueuedManualRuns,
    claimQueuedManualRun,
    yieldActiveRunToManual,
  };
}
