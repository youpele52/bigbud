import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  PROJECTION_BASELINE_TABLES,
  PROJECTION_BASELINE_THREAD_OWNED_TABLES,
} from "../ProjectionBaselineSchema.ts";
import { ProjectionBaselineRepository } from "../Services/ProjectionBaselines.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionBaselineRepositoryLive } from "./ProjectionBaselines.ts";
import {
  type BaselinePayload,
  sanitizeLegacyThreadOwnedRows,
} from "./ProjectionBaselines.payload.ts";
import { insertProjectionThreadParent } from "./ProjectionThread.test.helpers.ts";

const layer = it.layer(
  Layer.fresh(ProjectionBaselineRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
);

function emptyPayload(): BaselinePayload {
  return {
    tables: Object.fromEntries(PROJECTION_BASELINE_TABLES.map((table) => [table, []])),
  };
}

it("filters every thread-owned baseline table and reports only bounded table counts", () => {
  const payload = emptyPayload();
  payload.tables.projection_threads = [{ thread_id: "valid-thread" }];
  for (const table of PROJECTION_BASELINE_THREAD_OWNED_TABLES) {
    payload.tables[table] = [
      { thread_id: "valid-thread", value: `valid-${table}` },
      { thread_id: "legacy-orphan", value: `orphan-${table}` },
    ];
  }

  const result = sanitizeLegacyThreadOwnedRows(payload);
  for (const table of PROJECTION_BASELINE_THREAD_OWNED_TABLES) {
    assert.deepEqual(result.payload.tables[table], [
      { thread_id: "valid-thread", value: `valid-${table}` },
    ]);
  }
  assert.equal(result.sanitization.length, PROJECTION_BASELINE_THREAD_OWNED_TABLES.length);
  assert.isTrue(result.sanitization.every((entry) => entry.removedCount === 1));
  assert.isTrue(
    result.sanitization.every(
      (entry) => Object.keys(entry).toSorted().join(",") === "removedCount,table",
    ),
  );
  const metadata = JSON.stringify(result.sanitization);
  assert.notInclude(metadata, "valid-thread");
  assert.notInclude(metadata, "legacy-orphan");
  assert.notInclude(metadata, "orphan-");
});

layer("legacy projection baseline restore", (it) => {
  it.effect(
    "restores valid rows, drops an orphan session, and permits a new verified baseline",
    () =>
      Effect.gen(function* () {
        const baselines = yield* ProjectionBaselineRepository;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.makeUnsafe("legacy-valid-thread");
        yield* insertProjectionThreadParent({ sql, threadId });
        yield* sql`
        INSERT INTO projection_thread_sessions (thread_id, status, updated_at)
        VALUES (${threadId}, 'ready', '2026-09-03T00:00:00.000Z')
      `;
        const payload = JSON.parse(yield* baselines.capturePayload()) as BaselinePayload;
        const validSession = payload.tables.projection_thread_sessions![0]!;
        payload.tables.projection_thread_sessions = [
          validSession,
          { ...validSession, thread_id: "legacy-orphan-session" },
        ];

        yield* baselines.restorePayload(JSON.stringify(payload), 0, []);
        const sessions = yield* sql<{ readonly threadId: string; readonly status: string }>`
        SELECT thread_id AS "threadId", status FROM projection_thread_sessions
      `;
        assert.deepEqual(sessions, [{ threadId, status: "ready" }]);

        const candidate = yield* baselines.createCandidate([]);
        assert.isTrue(Option.isSome(candidate));
        if (Option.isSome(candidate)) {
          yield* baselines.markVerified(candidate.value.baselineId, 0, "2026-09-03T00:00:01.000Z");
        }
        assert.isTrue(Option.isSome(yield* baselines.latestVerified()));
      }),
  );

  it.effect("rejects malformed owned rows instead of treating them as legacy orphans", () =>
    Effect.gen(function* () {
      const baselines = yield* ProjectionBaselineRepository;
      const payload = emptyPayload();
      payload.tables.projection_thread_sessions = [{ status: "ready" }];
      assert.equal(
        (yield* Effect.exit(baselines.restorePayload(JSON.stringify(payload), 0, [])))._tag,
        "Failure",
      );
    }),
  );

  it.effect("preserves unrelated integrity failures", () =>
    Effect.gen(function* () {
      const baselines = yield* ProjectionBaselineRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("duplicate-session-thread");
      yield* insertProjectionThreadParent({ sql, threadId });
      yield* sql`
        INSERT INTO projection_thread_sessions (thread_id, status, updated_at)
        VALUES (${threadId}, 'ready', '2026-09-03T00:00:00.000Z')
      `;
      const payload = JSON.parse(yield* baselines.capturePayload()) as BaselinePayload;
      payload.tables.projection_thread_sessions = [
        payload.tables.projection_thread_sessions![0]!,
        payload.tables.projection_thread_sessions![0]!,
      ];
      assert.equal(
        (yield* Effect.exit(baselines.restorePayload(JSON.stringify(payload), 0, [])))._tag,
        "Failure",
      );
    }),
  );
});
