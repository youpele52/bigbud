import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterAll } from "vitest";

import * as SqliteClient from "./NodeSqliteClient.ts";

const directory = mkdtempSync(join(tmpdir(), "bigbud-sqlite-prepare-cache-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

// A statement that fails to prepare before a schema repair must succeed right after the repair
// on the same connection: failed prepares are never cached, only successful ones.
const failedPrepareIsRetried = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE progress (singleton INTEGER PRIMARY KEY, anchor TEXT)`;
  yield* sql`INSERT INTO progress (singleton) VALUES (1)`;
  const read = sql<{ readonly late: string | null }>`SELECT late FROM progress`;

  const failed = yield* Effect.flip(read);
  assert.include(String(failed.reason.cause), "no such column: late");

  yield* sql`ALTER TABLE progress ADD COLUMN late TEXT`;
  assert.deepEqual(yield* read, [{ late: null }]);
  // The now-successful statement stays usable (and cached) afterwards.
  yield* sql`UPDATE progress SET late = 'set'`;
  assert.deepEqual(yield* read, [{ late: "set" }]);
});

for (const worker of [false, true]) {
  it.effect(`retries a failed prepare after a schema change (worker: ${worker})`, () =>
    failedPrepareIsRetried.pipe(
      Effect.provide(
        Layer.fresh(
          SqliteClient.layer({ filename: join(directory, `cache-${worker}.sqlite`), worker }),
        ),
      ),
    ),
  );
}
