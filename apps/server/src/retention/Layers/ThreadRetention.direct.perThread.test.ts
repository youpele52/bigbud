import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { ThreadRetentionRepositoryLive } from "../../persistence/Layers/ThreadRetentionRepository.ts";
import { ThreadRetentionRepository } from "../../persistence/Services/ThreadRetentionRepository.ts";
import { runDirectThreadRetentionCoordinated } from "./ThreadRetention.direct.ts";

const layer = it.layer(
  ThreadRetentionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
const oldAt = "2026-01-01T00:00:00.000Z";
const cutoffAt = "2026-02-01T00:00:00.000Z";
const threadId = ThreadId.makeUnsafe("retention-proof-thread");

layer("per-thread retention cleanup proof", (it) => {
  it.effect("recovers pending cleanup and an ambiguous DB-busy finalization", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ThreadRetentionRepository;
      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('proof-project', 'Proof', '/proof', '[]', ${oldAt}, ${oldAt})`;
      yield* sql`INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at)
        VALUES (${threadId}, 'proof-project', 'Proof',
          '{"provider":"codex","model":"test"}', 'full-access', 'default',
          ${oldAt}, ${oldAt})`;
      const start = Date.now();
      const queued = yield* repository.createOrGetActiveRun({
        runId: "proof-run",
        trigger: "manual",
        policy: "7-days",
        selectionMode: "per-thread",
        ageCriterion: "created",
        cutoffAt,
        createdAt: new Date(start).toISOString(),
      });
      let cleanupState: "pending" | "completed" = "pending";
      let cleanupReadBusy = false;
      let dispatched = 0;
      let selectedPages = 0;
      let outstandingReads = 0;
      const orchestration = {
        dispatch: (command: {
          runId: string;
          threadId: ThreadId;
          expectedLastActivityAt: string;
          cutoffAt: string;
        }) =>
          Effect.gen(function* () {
            yield* repository.recheckAndClaimItem({
              runId: command.runId,
              threadId: command.threadId,
              expectedLastActivityAt: command.expectedLastActivityAt,
              cutoffAt: command.cutoffAt,
              claimedAt: new Date(start).toISOString(),
            });
            dispatched += 1;
            return { sequence: dispatched };
          }),
        getReadModel: () => Effect.succeed({ threads: [] } as never),
        streamDomainEvents: Stream.empty,
      } as never;
      const runnerRepository = {
        ...repository,
        selectNextPage: (input: Parameters<typeof repository.selectNextPage>[0]) => {
          if (++selectedPages > 10) return Effect.die(new Error("selection did not advance"));
          return repository.selectNextPage(input);
        },
        listOutstandingItems: (runId: string, limit: number) => {
          if (++outstandingReads > 10)
            return Effect.die(new Error("outstanding items did not advance"));
          return repository.listOutstandingItems(runId, limit);
        },
        readCleanupState: () =>
          cleanupReadBusy
            ? Effect.fail(
                new PersistenceSqlError({ operation: "readCleanupState", detail: "SQLITE_BUSY" }),
              )
            : Effect.succeed(cleanupState),
      };
      const first = yield* runDirectThreadRetentionCoordinated({
        run: queued,
        repository: runnerRepository,
        orchestration,
        now: () => start,
        settleTimeoutMs: 0,
        onSelectionPagePersisted: () => Effect.succeed(false),
      });
      assert.equal(first.kind, "yielded");
      const deferred = yield* repository.getRun("proof-run");
      assert.isTrue(Option.isSome(deferred));
      if (Option.isNone(deferred)) return;
      assert.equal(deferred.value.status, "deferred");
      assert.equal(deferred.value.failedCount, 0);
      assert.equal(deferred.value.completedCount, 0);
      assert.equal((yield* repository.listRunItems("proof-run"))[0]?.status, "deletion_requested");

      cleanupState = "completed";
      const resumed = yield* repository.claimNextQueuedRun(new Date(start + 31_000).toISOString());
      assert.isTrue(Option.isSome(resumed));
      if (Option.isNone(resumed)) return;
      cleanupReadBusy = true;
      const busy = yield* Effect.exit(
        runDirectThreadRetentionCoordinated({
          run: resumed.value,
          repository: runnerRepository,
          orchestration,
          now: () => start + 31_000,
          settleTimeoutMs: 0,
          onSelectionPagePersisted: () => Effect.succeed(false),
        }),
      );
      assert.equal(busy._tag, "Failure");
      assert.equal(Option.getOrThrow(yield* repository.getRun("proof-run")).status, "selecting");
      assert.equal(Option.getOrThrow(yield* repository.getRun("proof-run")).uncertainCount, 1);
      cleanupReadBusy = false;
      const second = yield* runDirectThreadRetentionCoordinated({
        run: Option.getOrThrow(yield* repository.getRun("proof-run")),
        repository: runnerRepository,
        orchestration,
        now: () => start + 31_000,
        settleTimeoutMs: 0,
        onSelectionPagePersisted: () => Effect.succeed(false),
      });
      assert.equal(second.kind, "completed");
      const finished = yield* repository.getRun("proof-run");
      assert.isTrue(Option.isSome(finished));
      if (Option.isNone(finished)) return;
      assert.equal(finished.value.status, "completed");
      assert.equal(finished.value.completedCount, 1);
      assert.equal(finished.value.failedCount, 0);
      assert.equal(finished.value.uncertainCount, 0);
      assert.equal(dispatched, 3);
    }),
  );
});
