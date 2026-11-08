/**
 * Settles tasks a finished turn left open. A task still `pending`/`inProgress` 24 hours after its
 * last update, on a thread with no turn in progress, belongs to no running work: thread
 * retention already ignores it, and this marks it `stopped` so the thread's task list agrees.
 *
 * Runs on backend start (every thread, a bounded number of pages) and when a turn ends (that
 * thread only). Background subagents legitimately outlive their turn, so a task updated within
 * the last 24 hours is never touched. Each task is settled through `thread.task.upsert`, the
 * same event a provider or the Stop sweep would record.
 *
 * @module ProviderRuntimeIngestion.staleTasks
 */
import { OrchestrationTask, ThreadId } from "@bigbud/contracts";
import { Cause, Effect, Option, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { buildStoppedSubagentSnapshot } from "../SubagentStopSweep.logic.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { serverCommandId } from "./ProviderCommandReactorHelpers.ts";

export const STALE_TASK_AGE_MS = 24 * 60 * 60_000;
export const STALE_TASK_PAGE = 100;
const STARTUP_MAX_PAGES = 20;
/** Shown as the task's Reason when bigbud, not the provider, settled it. */
export const STALE_TASK_STOPPED_REASON = "Stopped after its turn ended";

const decodeTask = Schema.decodeUnknownOption(Schema.fromJsonString(OrchestrationTask));

export const settleStaleThreadTasks = Effect.fn("settleStaleThreadTasks")(function* (
  deps: {
    readonly sql: SqlClient.SqlClient;
    readonly orchestrationEngine: Pick<OrchestrationEngineShape, "dispatch">;
  },
  input: { readonly threadId?: string; readonly nowMs?: number } = {},
) {
  const nowMs = input.nowMs ?? Date.now();
  const staleBefore = new Date(nowMs - STALE_TASK_AGE_MS).toISOString();
  const threadFilter = input.threadId ?? null;
  let settled = 0;
  for (let page = 0; page < (threadFilter === null ? STARTUP_MAX_PAGES : 1); page += 1) {
    const rows = yield* deps.sql<{ readonly threadId: string; readonly taskJson: string }>`
      SELECT task.thread_id AS "threadId", task.task_json AS "taskJson"
      FROM projection_thread_tasks AS task
      JOIN projection_threads AS thread ON thread.thread_id = task.thread_id
      WHERE (${threadFilter} IS NULL OR task.thread_id = ${threadFilter})
        AND json_valid(task.task_json)
        AND json_extract(task.task_json, '$.status') IN ('pending', 'inProgress')
        AND task.updated_at <= ${staleBefore}
        AND thread.deleted_at IS NULL AND thread.deleting_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM projection_thread_sessions AS session
          WHERE session.thread_id = task.thread_id
            AND (session.status IN ('starting', 'running') OR session.active_turn_id IS NOT NULL)
        )
      ORDER BY task.updated_at ASC, task.task_id ASC
      LIMIT ${STALE_TASK_PAGE}
    `;
    let dispatched = 0;
    for (const row of rows) {
      const task = decodeTask(row.taskJson);
      if (Option.isNone(task)) continue;
      const stoppedAt = new Date(nowMs).toISOString();
      const stopped = {
        ...buildStoppedSubagentSnapshot(task.value, stoppedAt),
        terminalReason: task.value.terminalReason ?? STALE_TASK_STOPPED_REASON,
      };
      const outcome = yield* deps.orchestrationEngine
        .dispatch({
          type: "thread.task.upsert",
          commandId: serverCommandId("stale-task-stop"),
          threadId: ThreadId.makeUnsafe(row.threadId),
          task: stopped,
          createdAt: stoppedAt,
        })
        .pipe(Effect.exit);
      if (outcome._tag === "Success") {
        dispatched += 1;
      } else {
        yield* Effect.logWarning("stale task was not marked stopped", {
          threadId: row.threadId,
          taskId: task.value.id,
          cause: Cause.pretty(outcome.cause),
        });
      }
    }
    settled += dispatched;
    // A page that settled nothing would be read again unchanged, so stop.
    if (rows.length < STALE_TASK_PAGE || dispatched === 0) break;
    yield* Effect.yieldNow;
  }
  return settled;
});
