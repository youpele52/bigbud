import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import {
  listUnresolvedSshOwnerRetirements,
  markSshOwnerRetirementRetired,
  readSshOwnerRetirement,
  recordSshOwnerRetirementBinding,
  recordSshOwnerRetirementIntent,
} from "./SshOwnerRetirement.ts";

const profile = "dev-profile";
const target = "ssh:fixture";

const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 184 });
  return sql;
});

const intent = (sql: SqlClient.SqlClient) =>
  recordSshOwnerRetirementIntent(sql, {
    profileScope: profile,
    targetId: target,
    detail: "before spawn",
  });

const binding = (sql: SqlClient.SqlClient) =>
  recordSshOwnerRetirementBinding(sql, {
    profileScope: profile,
    targetId: target,
    detail: "master bound",
    ownerEpoch: "owner-epoch",
    generation: "generation",
    pid: 4242,
    startTime: "987654321",
    namespace: "12:34",
  });

it.effect("records an intent, completes it once, and never overwrites unresolved evidence", () =>
  Effect.gen(function* () {
    const sql = yield* migrated;
    assert.equal(yield* intent(sql), "recorded");
    assert.equal(yield* binding(sql), "recorded");
    assert.equal(
      yield* readSshOwnerRetirement(sql, profile, target).pipe(Effect.map((row) => row?.state)),
      "bound",
    );
    // A second intent or binding is refused while the row is unresolved.
    assert.equal(yield* intent(sql), "unresolved");
    assert.equal(yield* binding(sql), "conflict");
    assert.deepEqual(
      yield* listUnresolvedSshOwnerRetirements(sql, profile).pipe(
        Effect.map((rows) => rows.map((row) => [row.targetId, row.state, row.pid, row.namespace])),
      ),
      [[target, "bound", 4242, "12:34"]],
    );
    // Only verified retirement clears it, and a retired row may be re-used.
    assert.equal(
      yield* markSshOwnerRetirementRetired(sql, profile, target, "verified gone"),
      "retired",
    );
    assert.deepEqual(yield* listUnresolvedSshOwnerRetirements(sql, profile), []);
    assert.equal(yield* intent(sql), "recorded");
    const row = yield* readSshOwnerRetirement(sql, profile, target);
    assert.equal(row?.state, "intent");
    assert.equal(row?.pid, null);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("refuses a binding without an intent and isolates profiles", () =>
  Effect.gen(function* () {
    const sql = yield* migrated;
    assert.equal(yield* binding(sql), "conflict");
    assert.equal(
      yield* recordSshOwnerRetirementBinding(sql, {
        profileScope: "other",
        targetId: target,
        detail: "no intent",
        ownerEpoch: "e",
        generation: "g",
        pid: 1,
        startTime: "2",
        namespace: null,
      }),
      "conflict",
    );
    assert.equal(yield* intent(sql), "recorded");
    assert.deepEqual(
      yield* listUnresolvedSshOwnerRetirements(sql, "other").pipe(
        Effect.map((rows) => rows.length),
      ),
      0,
    );
    // macOS has no PID namespace; a bounded row still requires pid and start.
    assert.equal(
      yield* recordSshOwnerRetirementBinding(sql, {
        profileScope: profile,
        targetId: target,
        detail: "macOS bound",
        ownerEpoch: "e",
        generation: "g",
        pid: 7,
        startTime: "8",
        namespace: null,
      }),
      "recorded",
    );
    assert.equal(yield* markSshOwnerRetirementRetired(sql, profile, target, "reaped"), "retired");
    assert.equal(yield* markSshOwnerRetirementRetired(sql, profile, target, "again"), "missing");
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
