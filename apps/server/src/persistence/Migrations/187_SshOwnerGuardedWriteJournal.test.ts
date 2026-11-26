import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { initializeProductionSshGuardedWriteJournal } from "../Layers/SshOwnerGuardedWriteJournal.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const columns = (sql: SqlClient.SqlClient) =>
  sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('ssh_owner_guarded_write_journal') ORDER BY cid`;

const binding = {
  operationId: "op-1",
  profileId: "production:aa:bb",
  targetId: "ssh:prod-box",
  cwd: "/srv/work",
  relativePath: "notes.txt",
  baseSha256: "a".repeat(64),
  attemptedSha256: "b".repeat(64),
  byteSize: 3,
};

it.effect("creates the B-side guarded-save journal and stays idempotent with its bootstrap", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 186 });
    assert.deepEqual(yield* columns(sql), []);
    yield* runMigrations({ toMigrationInclusive: 187 });
    assert.deepEqual(
      (yield* columns(sql)).map((row) => row.name),
      [
        "operation_id",
        "profile_id",
        "target_id",
        "cwd",
        "relative_path",
        "base_sha256",
        "attempted_sha256",
        "byte_size",
        "receipt_kind",
        "receipt_sha256",
      ],
    );
    // The journal's own bootstrap over the migrated table is a no-op, and it
    // keeps the one-claim/one-receipt semantics.
    const journal = yield* initializeProductionSshGuardedWriteJournal(sql, true);
    assert.deepEqual(yield* journal.claim(binding), { kind: "claimed" });
    assert.deepEqual(yield* journal.claim(binding), { kind: "existing", receipt: null });
    assert.deepEqual(
      yield* journal.recordReceipt(binding, {
        kind: "saved",
        resultSha256: binding.attemptedSha256,
      }),
      { kind: "recorded" },
    );
    assert.deepEqual(yield* journal.lookup(binding), {
      kind: "existing",
      receipt: { kind: "saved", resultSha256: binding.attemptedSha256 },
    });
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
