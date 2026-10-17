import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { DirectResourceCleanupRepositoryLive } from "../Layers/DirectResourceCleanupRepository.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { DirectResourceCleanupRepository } from "../Services/DirectResourceCleanupRepository.ts";
import repair from "./129_RepairDirectResourceCleanupRequests.ts";
import {
  at,
  initialize,
  makeLegacySchema,
  requestColumns,
  seedAttempt,
  seedPlan,
} from "./129_RepairDirectResourceCleanupRequests.test.helpers.ts";

const layer = DirectResourceCleanupRepositoryLive.pipe(
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
);

it.effect("repairs the installed empty attempt table through a new forward migration", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* DirectResourceCleanupRepository;
    yield* initialize;
    yield* makeLegacySchema(sql);
    assert.deepEqual(
      (yield* runMigrations()).filter(([id]) => id === 129),
      [[129, "RepairDirectResourceCleanupRequests"]],
    );
    const columns = yield* sql<{
      readonly name: string;
    }>`PRAGMA table_info(direct_resource_cleanup_attempts)`;
    for (const name of requestColumns)
      assert.isTrue(columns.some((column) => column.name === name));
    assert.equal(yield* repository.loadAmbiguousAttempt("absent", 0), undefined);
    assert.deepEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "preserves legacy history without fabricating replay requests or reactivating unsafe plans",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* DirectResourceCleanupRepository;
      yield* initialize;
      const states = ["ready", "running", "retry", "blocked", "completed", "cancelled"] as const;
      for (const state of states) {
        yield* seedPlan(sql, state, state);
        yield* seedAttempt(sql, state, state === "completed" ? "recorded" : "ambiguous");
      }
      yield* makeLegacySchema(sql);
      const attempts =
        yield* sql`SELECT * FROM direct_resource_cleanup_attempts ORDER BY attempt_id`;
      const resources =
        yield* sql`SELECT * FROM direct_resource_cleanup_resources ORDER BY operation_id`;
      const proofs = yield* sql`SELECT * FROM direct_resource_cleanup_proofs ORDER BY operation_id`;
      yield* runMigrations();
      assert.deepEqual(
        yield* sql`
      SELECT attempt_id, operation_id, page_ordinal, page_digest, resource_ids_json, state, created_at, updated_at
      FROM direct_resource_cleanup_attempts ORDER BY attempt_id
    `,
        attempts,
      );
      assert.deepEqual(
        yield* sql`SELECT * FROM direct_resource_cleanup_resources ORDER BY operation_id`,
        resources,
      );
      assert.deepEqual(
        yield* sql`SELECT * FROM direct_resource_cleanup_proofs ORDER BY operation_id`,
        proofs,
      );
      assert.deepEqual(
        yield* sql`
      SELECT DISTINCT request_json, request_frame_hex, deadline_unix_ms FROM direct_resource_cleanup_attempts
    `,
        [{ request_json: null, request_frame_hex: null, deadline_unix_ms: null }],
      );
      for (const state of states) {
        const [plan] = yield* sql<{ readonly state: string; readonly lease_id: string | null }>`
        SELECT state, lease_id FROM direct_resource_cleanup_plans WHERE operation_id = ${state}
      `;
        assert.equal(
          plan?.state,
          state === "completed" || state === "cancelled" ? state : "blocked",
        );
        assert.equal(plan?.lease_id, null);
      }
      assert.equal(
        yield* repository.claimReady({
          leaseId: "new-lease",
          claimedAt: at,
          expiresAt: "2999-01-01",
          expectedPlatform: "darwin/arm64",
        }),
        undefined,
      );
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(repository.loadAmbiguousAttempt("ready", 0))),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(sql`
      UPDATE direct_resource_cleanup_plans SET state = 'ready' WHERE operation_id = 'ready'
    `),
        ),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(sql`
      UPDATE direct_resource_cleanup_attempts SET request_json = '{}' WHERE attempt_id = 'ready'
    `),
        ),
      );
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      assert.deepEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "preserves complete requests on modern schemas and keeps request identities immutable",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* DirectResourceCleanupRepository;
      yield* initialize;
      yield* seedPlan(sql, "modern");
      yield* seedAttempt(sql, "modern");
      const before = yield* sql`SELECT * FROM direct_resource_cleanup_attempts`;
      yield* runMigrations();
      assert.deepEqual(yield* sql`SELECT * FROM direct_resource_cleanup_attempts`, before);
      assert.equal(
        (yield* repository.loadAmbiguousAttempt("modern", 0))?.requestJson,
        '{"original":true}',
      );
      assert.isTrue(
        yield* repository.claimOperation({
          operationId: "modern",
          leaseId: "lease",
          claimedAt: at,
          expiresAt: "2999-01-01",
          expectedPlatform: "darwin/arm64",
        }),
      );
      for (const column of requestColumns) {
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              sql.unsafe(
                `UPDATE direct_resource_cleanup_attempts SET ${column} = NULL WHERE attempt_id = 'modern'`,
              ),
            ),
          ),
        );
      }
    }).pipe(Effect.provide(layer)),
);

for (const missing of requestColumns) {
  it.effect(
    `repairs a partial schema missing only ${missing} without overwriting available request data`,
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* initialize;
        yield* seedPlan(sql, "partial");
        yield* seedAttempt(sql, "partial");
        yield* makeLegacySchema(sql, [missing]);
        yield* runMigrations();
        const requests = yield* sql`SELECT request_json, request_frame_hex, deadline_unix_ms
        FROM direct_resource_cleanup_attempts`;
        assert.deepEqual(requests, [
          {
            request_json: missing === "request_json" ? null : '{"original":true}',
            request_frame_hex: missing === "request_frame_hex" ? null : "0000000000",
            deadline_unix_ms: missing === "deadline_unix_ms" ? null : 1800000000000,
          },
        ]);
        const plans = yield* sql`SELECT * FROM direct_resource_cleanup_plans`;
        yield* sql.withTransaction(repair);
        assert.deepEqual(yield* sql`SELECT * FROM direct_resource_cleanup_plans`, plans);
        assert.deepEqual(
          yield* sql`SELECT request_json, request_frame_hex, deadline_unix_ms
        FROM direct_resource_cleanup_attempts`,
          requests,
        );
      }).pipe(Effect.provide(layer)),
  );
}

it.effect("requires valid original request data on every new attempt after legacy repair", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* initialize;
    yield* makeLegacySchema(sql);
    yield* runMigrations();
    yield* seedPlan(sql, "guard");
    for (const [requestJson, frame, deadline] of [
      [null, "0000000000", 1],
      ["{}", null, 1],
      ["{}", "0000000000", null],
      ["invalid", "0000000000", 1],
      ["{}", "abcd", 1],
      ["{}", "000000000g", 1],
      ["{}", "0000000000", -1],
    ] as const) {
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(sql`
        INSERT INTO direct_resource_cleanup_attempts (
          attempt_id, operation_id, page_ordinal, page_digest, resource_ids_json,
          request_json, request_frame_hex, deadline_unix_ms, state, created_at, updated_at
        ) VALUES ('invalid', 'guard', 0, 'page', '["resource"]', ${requestJson}, ${frame},
          ${deadline}, 'prepared', ${at}, ${at})
      `),
        ),
      );
    }
    yield* seedAttempt(sql, "guard", "prepared");
    yield* sql`UPDATE direct_resource_cleanup_attempts SET state = 'sent' WHERE attempt_id = 'guard'`;
    for (const [column, value] of [
      ["request_json", "'{}'"],
      ["request_frame_hex", "'1111111111'"],
      ["deadline_unix_ms", "1"],
    ]) {
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            sql.unsafe(
              `UPDATE direct_resource_cleanup_attempts SET ${column} = ${value} WHERE attempt_id = 'guard'`,
            ),
          ),
        ),
      );
    }
    assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
  }).pipe(Effect.provide(layer)),
);

it.effect("rolls back schema and plan changes together when repair is interrupted", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* initialize;
    yield* seedPlan(sql, "interrupted", "running");
    yield* seedAttempt(sql, "interrupted");
    yield* makeLegacySchema(sql);
    const schema = yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`;
    const plans = yield* sql`SELECT * FROM direct_resource_cleanup_plans`;
    const attempts = yield* sql`SELECT * FROM direct_resource_cleanup_attempts`;
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          sql.withTransaction(
            repair.pipe(Effect.andThen(Effect.fail(new Error("interrupted repair")))),
          ),
        ),
      ),
    );
    assert.deepEqual(yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`, schema);
    assert.deepEqual(yield* sql`SELECT * FROM direct_resource_cleanup_plans`, plans);
    assert.deepEqual(yield* sql`SELECT * FROM direct_resource_cleanup_attempts`, attempts);
    assert.deepEqual(
      (yield* runMigrations()).filter(([id]) => id === 129),
      [[129, "RepairDirectResourceCleanupRequests"]],
    );
    assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
    assert.deepEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
  }).pipe(Effect.provide(layer)),
);
