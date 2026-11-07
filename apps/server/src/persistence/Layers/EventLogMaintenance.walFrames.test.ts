import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeEventLogMaintenance } from "./EventLogMaintenance.ts";
import { batchWalFrames, MAINTENANCE_BATCH } from "./EventLogMaintenance.scheduler.ts";
import { IDLE_SIGNALS, NOW_MS, seedCompactableLog } from "./EventLogMaintenance.test.helpers.ts";
import { makeSqlitePersistenceLive } from "./Sqlite.ts";

describe("batch WAL frames", () => {
  it("counts only the frames written after the checkpoint before the batch", () => {
    // A long reader keeps 3,000 frames from being copied back: only the 120 new ones count.
    assert.equal(
      batchWalFrames({ log: 3_000, checkpointed: 10 }, { log: 3_120, checkpointed: 10 }),
      120,
    );
  });

  it("takes the whole count once the WAL may have started over", () => {
    // Fully copied back before the batch: the batch's write restarts the WAL from frame 1.
    assert.equal(
      batchWalFrames({ log: 900, checkpointed: 900 }, { log: 150, checkpointed: 150 }),
      150,
    );
    assert.equal(batchWalFrames({ log: 0, checkpointed: 0 }, { log: 80, checkpointed: 80 }), 80);
    // A smaller count after the batch can only mean a restart.
    assert.equal(
      batchWalFrames({ log: 900, checkpointed: 400 }, { log: 50, checkpointed: 50 }),
      50,
    );
  });

  it("is unknown without WAL mode", () => {
    assert.isNull(batchWalFrames(null, { log: 1, checkpointed: 1 }));
    assert.isNull(batchWalFrames({ log: 1, checkpointed: 1 }, null));
  });
});

/**
 * A long reader pins the WAL while another writer fills it with thousands of frames. The WAL's
 * frame count stays above the per-batch page cap for every batch, so counting it as the batch's
 * cost held every batch at the 100-row minimum; the batch's own frames let the size grow.
 */
it.effect(
  "grows batch sizes while a long reader pins other writers' frames in the WAL",
  () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "bigbud-wal-frames-")));
      const dbPath = path.join(dir, "state.sqlite");
      const sizes: Array<number> = [];
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedCompactableLog(sql, { count: 6_000 });
        yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
        const reader = new DatabaseSync(dbPath, { readOnly: true });
        yield* Effect.addFinalizer(() => Effect.sync(() => reader.close()));
        reader.exec("BEGIN");
        reader.prepare("SELECT COUNT(*) FROM orchestration_events").get();
        // Another writer's frames, which the reader's snapshot keeps in the WAL.
        yield* sql`CREATE TABLE wal_frames_test_junk (payload BLOB)`;
        yield* sql`
          WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
          INSERT INTO wal_frames_test_junk SELECT randomblob(3000) FROM n
        `;
        const [wal] = yield* sql<{ readonly log: number }>`PRAGMA wal_checkpoint(PASSIVE)`;
        assert.isAbove(wal?.log ?? 0, 2_000);

        const maintenance = yield* makeEventLogMaintenance({
          now: () => NOW_MS,
          readSignals: () => Effect.succeed(IDLE_SIGNALS),
          floorInputs: () => ({ reactorCursor: null, deliveryAcknowledged: null }),
          hotWindow: { sequences: 100, ms: 60_000 },
          onBatch: (kind, _elapsedMs, _rows, size) => {
            if (kind === "events") sizes.push(size);
          },
        });
        for (let tick = 0; tick < 20; tick += 1) {
          const report = yield* maintenance.service.runTick;
          assert.isFalse(report.failed);
          if (report.drained) break;
        }
        reader.exec("COMMIT");
      }).pipe(
        Effect.scoped,
        Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
        Effect.ensuring(Effect.promise(() => rm(dir, { recursive: true, force: true }))),
      );
      assert.isAbove(sizes.length, 1);
      assert.isAbove(Math.max(...sizes), MAINTENANCE_BATCH.min);
    }),
  { timeout: 120_000 },
);
