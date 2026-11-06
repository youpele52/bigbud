import { expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  makeOrganizationSnapshotCapture,
  ORGANIZATION_CAPTURE_BUDGET,
  organizationCaptureBudgetMs,
} from "./organizationSnapshot.capture.ts";
import { makeOrganizationObservationPass } from "./organizationBridge.loops.ts";
import { makeOrganizationFactStore } from "./organizationFacts.store.ts";
import { OrganizationObservation } from "./organizationObservation.ts";

it.each([5000, 10000])(
  "captures %i synthetic threads within its budget while admitting a concurrent write",
  async (count) => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
          VALUES ('scale-test', 0, '2026-11-06T00:00:00.000Z')`;
        yield* sql`WITH RECURSIVE ids(n) AS (
          SELECT 1 UNION ALL SELECT n + 1 FROM ids WHERE n < ${count}
        ) INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) SELECT printf('scale-%05d', n), 'scale-project', 'Synthetic',
          '{"provider":"codex","model":"fixture"}', 'full-access', 'default',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z' FROM ids`;
        let samples = 0;
        let writeMs = -1;
        const idle = {
          terminal: { state: "idle" as const, quietSince: null },
          shell: "idle" as const,
        };
        const capture = makeOrganizationSnapshotCapture({
          sql,
          owners: () =>
            Effect.gen(function* () {
              if (++samples === 50) {
                const started = performance.now();
                // A separate transaction must acquire the connection before capture finishes.
                yield* sql
                  .withTransaction(
                    sql`UPDATE projection_threads SET organization_state = 'later'
                      WHERE thread_id = 'scale-00100'`,
                  )
                  .pipe(Effect.timeout("2 seconds"));
                writeMs = performance.now() - started;
              }
              return idle;
            }),
        });
        const started = performance.now();
        const snapshot = yield* capture(300000);
        const elapsedMs = performance.now() - started;
        const observations = new OrganizationObservation();
        observations.rescan = true;
        let refreshed = 0;
        const store = makeOrganizationFactStore({
          sql,
          owners: () => Effect.succeed(idle),
          now: Date.now,
        });
        const pass = makeOrganizationObservationPass({
          sql,
          liveness: {
            ready: true,
            launchedAt: Date.now(),
            progressAt: Date.now(),
            lastNativeAt: Date.now(),
          },
          observations,
          captureOverflowed: Effect.succeed(false),
          refresh: (id) =>
            store.observe(id, 300000).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  refreshed++;
                }),
              ),
              Effect.asVoid,
            ),
        });
        const passStarted = performance.now();
        yield* pass;
        return { snapshot, elapsedMs, writeMs, refreshed, passMs: performance.now() - passStarted };
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
    );
    expect(result.snapshot.rows).toHaveLength(count);
    expect(result.snapshot.rows.find((row) => row.threadId === "scale-00100")?.section).toBe(3);
    expect(result.writeMs).toBeGreaterThanOrEqual(0);
    expect(result.writeMs).toBeLessThan(2000);
    // The measured per-row cost sizes the production budget: keep at least 5x headroom.
    expect(result.elapsedMs).toBeLessThan(organizationCaptureBudgetMs(count, 0));
    expect((result.elapsedMs / count) * 5).toBeLessThan(ORGANIZATION_CAPTURE_BUDGET.perRowMs);
    expect(result.refreshed).toBeGreaterThan(0);
    expect(result.refreshed).toBeLessThanOrEqual(32);
    // A pass is bounded by 200ms plus its final non-preemptible SQLite statement.
    expect(result.passMs).toBeLessThan(2000);
    console.info("organisation synthetic capture", {
      count,
      elapsedMs: Math.round(result.elapsedMs),
      perRowMs: Number((result.elapsedMs / count).toFixed(3)),
      concurrentWriteMs: Math.round(result.writeMs),
      passMs: Math.round(result.passMs),
      refreshed: result.refreshed,
    });
  },
  150000,
);
