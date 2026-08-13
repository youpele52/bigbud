import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type {
  CreateRetentionRunInput,
  ThreadRetentionRun,
} from "../Services/ThreadRetentionRepository.ts";
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
          trigger: "manual" | "scheduled";
          bypassUsed: number;
        }>`
          SELECT run_id AS "runId", trigger_kind AS trigger,
            queue_bypass_used AS "bypassUsed"
          FROM thread_retention_runs
          WHERE status = 'queued' AND active_slot IS NULL
          ORDER BY rowid ASC
        `;
        const oldest = queued[0];
        const firstManualIndex = queued.findIndex((run) => run.trigger === "manual");
        const manualMayOvertake =
          oldest?.trigger === "scheduled" &&
          oldest.bypassUsed === 0 &&
          firstManualIndex > 0 &&
          queued.slice(0, firstManualIndex).filter((run) => run.trigger === "scheduled").length ===
            1;
        const selected = manualMayOvertake ? queued[firstManualIndex] : oldest;
        if (selected === undefined) return Option.none();
        if (manualMayOvertake) {
          yield* input.sql`
            UPDATE thread_retention_runs SET queue_bypass_used = 1
            WHERE run_id = ${oldest.runId} AND status = 'queued' AND active_slot IS NULL
          `;
        }
        const rows = yield* input.sql<{ runId: string }>`
          UPDATE thread_retention_runs SET active_slot = 1, updated_at = ${claimedAt}
          WHERE run_id = ${selected.runId} AND status = 'queued' AND active_slot IS NULL
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

  return { createOrGetActiveRun, createQueuedRun, createScheduledQueuedRun, claimNextQueuedRun };
}
