import type { OrchestrationCommand } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  resetRetentionTestRows,
  seedRetentionTestThread,
} from "../../retention/threadRetention.test.helpers.ts";
import {
  settleStaleThreadTasks,
  STALE_TASK_AGE_MS,
  STALE_TASK_STOPPED_REASON,
} from "./ProviderRuntimeIngestion.staleTasks.ts";

const layer = it.layer(SqlitePersistenceMemory);
const nowMs = Date.parse("2026-03-01T00:00:00.000Z");
const staleAt = new Date(nowMs - STALE_TASK_AGE_MS - 1).toISOString();
const freshAt = new Date(nowMs - 60_000).toISOString();

const seedTask = Effect.fn("seedStaleTask")(function* (input: {
  readonly taskId: string;
  readonly threadId: string;
  readonly status: string;
  readonly updatedAt: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const task = {
    id: input.taskId,
    status: input.status,
    subject: `Task ${input.taskId}`,
    createdAt: staleAt,
    updatedAt: input.updatedAt,
  };
  yield* sql`INSERT INTO projection_thread_tasks (task_id, thread_id, task_json, created_at, updated_at)
    VALUES (${input.taskId}, ${input.threadId}, ${JSON.stringify(task)}, ${staleAt}, ${input.updatedAt})`;
});

const recordingEngine = () => {
  const commands: OrchestrationCommand[] = [];
  return {
    commands,
    engine: {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
    },
  };
};

layer("stale open tasks", (it) => {
  it.effect("marks only open tasks idle for 24 hours on threads with no turn running", () =>
    Effect.gen(function* () {
      yield* resetRetentionTestRows();
      const sql = yield* SqlClient.SqlClient;
      for (const threadId of ["idle", "busy", "turning"]) {
        yield* seedRetentionTestThread(threadId, staleAt);
      }
      yield* sql`INSERT INTO projection_thread_sessions (thread_id, status, updated_at)
        VALUES ('busy', 'running', ${staleAt})`;
      yield* sql`INSERT INTO projection_thread_sessions (thread_id, status, active_turn_id, updated_at)
        VALUES ('turning', 'ready', 'turn-1', ${staleAt})`;
      yield* seedTask({
        taskId: "stale",
        threadId: "idle",
        status: "inProgress",
        updatedAt: staleAt,
      });
      yield* seedTask({
        taskId: "pending",
        threadId: "idle",
        status: "pending",
        updatedAt: staleAt,
      });
      yield* seedTask({
        taskId: "fresh",
        threadId: "idle",
        status: "inProgress",
        updatedAt: freshAt,
      });
      yield* seedTask({
        taskId: "done",
        threadId: "idle",
        status: "completed",
        updatedAt: staleAt,
      });
      yield* seedTask({
        taskId: "busy",
        threadId: "busy",
        status: "inProgress",
        updatedAt: staleAt,
      });
      yield* seedTask({
        taskId: "turning",
        threadId: "turning",
        status: "inProgress",
        updatedAt: staleAt,
      });
      const recording = recordingEngine();

      const settled = yield* settleStaleThreadTasks(
        { sql, orchestrationEngine: recording.engine },
        {
          nowMs,
        },
      );

      assert.equal(settled, 2);
      const stopped = recording.commands.flatMap((command) =>
        command.type === "thread.task.upsert" ? [command] : [],
      );
      assert.deepEqual(
        stopped.map((command) => [String(command.threadId), String(command.task.id)]).toSorted(),
        [
          ["idle", "pending"],
          ["idle", "stale"],
        ],
      );
      for (const command of stopped) {
        assert.equal(command.task.status, "stopped");
        assert.equal(command.task.terminalReason, STALE_TASK_STOPPED_REASON);
        assert.equal(command.task.endedAt, new Date(nowMs).toISOString());
      }
    }),
  );

  it.effect("a turn-end pass touches only that thread", () =>
    Effect.gen(function* () {
      yield* resetRetentionTestRows();
      const sql = yield* SqlClient.SqlClient;
      yield* seedRetentionTestThread("ended", staleAt);
      yield* seedRetentionTestThread("elsewhere", staleAt);
      yield* seedTask({ taskId: "a", threadId: "ended", status: "inProgress", updatedAt: staleAt });
      yield* seedTask({
        taskId: "b",
        threadId: "elsewhere",
        status: "inProgress",
        updatedAt: staleAt,
      });
      const recording = recordingEngine();

      const settled = yield* settleStaleThreadTasks(
        { sql, orchestrationEngine: recording.engine },
        { threadId: "ended", nowMs },
      );

      assert.equal(settled, 1);
      assert.equal(recording.commands.length, 1);
      assert.equal(
        recording.commands[0]?.type === "thread.task.upsert" &&
          String(recording.commands[0].threadId),
        "ended",
      );
    }),
  );
});
