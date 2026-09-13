import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ThreadRetentionRepository } from "../../persistence/Services/ThreadRetentionRepository.ts";
import { ThreadRetentionRepositoryLive } from "../../persistence/Layers/ThreadRetentionRepository.ts";
import { insertProjectionThreadParent } from "../../persistence/Layers/ProjectionThread.test.helpers.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import {
  seedLegacyRetentionSchema,
  seedLegacyRetentionRun,
  seedLegacyRetentionItem,
} from "../../persistence/Migrations/117_RepairThreadRetentionItemIndependence.test.helpers.ts";
import { makeThreadRetentionExecutionCoordinator } from "./ThreadRetention.coordinator.ts";

const layer = ThreadRetentionRepositoryLive.pipe(
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
);

for (const status of ["selecting", "preparing", "purging"] as const) {
  it.effect(`recovers a ${status} run across deletion and migration, then drains queued work`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ThreadRetentionRepository;
      yield* seedLegacyRetentionSchema;
      yield* seedLegacyRetentionRun("interrupted", status);
      yield* seedLegacyRetentionItem("interrupted", "lost-outcome", "deletion_requested");
      yield* seedLegacyRetentionItem(
        "interrupted",
        "completed-before-restart",
        "deletion_requested",
      );
      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'lost-outcome'`;
      yield* seedLegacyRetentionRun("queued", "queued");
      yield* sql`UPDATE thread_retention_runs SET cutoff_at = '2026-08-20T00:00:00.000Z' WHERE run_id = 'queued'`;
      yield* insertProjectionThreadParent({
        sql,
        threadId: ThreadId.makeUnsafe("queued-thread"),
        projectId: "retention-project",
        createdAt: "2026-08-15T00:00:00.000Z",
      });
      yield* runMigrations();
      // Simulate shutdown after a successful deletion but before recording its outcome.
      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'completed-before-restart'`;
      const commands: string[] = [];
      const orchestration = {
        dispatch: (command: Parameters<OrchestrationEngineShape["dispatch"]>[0]) =>
          Effect.gen(function* () {
            if (command.type !== "thread.retention-delete")
              return yield* Effect.die("unexpected command");
            commands.push(command.commandId);
            const item = Option.getOrThrow(
              yield* repository.findItemByDeletionCommandId(command.commandId),
            );
            if (item.status === "selected") {
              const claimed = yield* repository.recheckAndClaimItem({
                runId: command.runId,
                threadId: command.threadId,
                expectedLastActivityAt: command.expectedLastActivityAt,
                cutoffAt: command.cutoffAt,
                claimedAt: command.createdAt,
              });
              assert.isTrue(claimed.claimed);
              yield* sql`DELETE FROM projection_threads WHERE thread_id = ${command.threadId}`;
            }
            return { sequence: 1 };
          }),
        getReadModel: () =>
          sql`
          SELECT thread_id AS id, deleted_at AS "deletedAt", deleting_at AS "deletingAt"
          FROM projection_threads
        `.pipe(Effect.map((threads) => ({ threads }))),
        streamDomainEvents: Stream.empty,
      } as never;
      const coordinator = yield* makeThreadRetentionExecutionCoordinator({
        repository,
        orchestration,
      });
      const result = yield* coordinator.execute("queued");
      const interrupted = Option.getOrThrow(yield* repository.getRun("interrupted"));
      assert.equal(interrupted.status, "completed_with_failures");
      assert.deepEqual([interrupted.completedCount, interrupted.failedCount], [1, 1]);
      assert.deepEqual([result.deletedCount, result.pendingCount], [1, 0]);
      assert.equal(commands[0], "delete:completed-before-restart");
      assert.lengthOf(commands, 2);
      assert.deepEqual(yield* repository.listRecoverableRuns(10), []);
      yield* coordinator.drain();
      assert.lengthOf(commands, 2);
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
    }).pipe(Effect.provide(layer)),
  );
}
