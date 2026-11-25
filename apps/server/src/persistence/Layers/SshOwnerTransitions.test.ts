import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import Migration0181 from "../Migrations/181_SshOwnerTransitions.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { createRemoteExecutionTargetDisconnectsTable } from "../RemoteExecutionTargetDisconnects.schema.ts";
import {
  applySshOwnerTransition,
  rotateSshOwnerWriterAndHydrate,
  type SshOwnerTransition,
} from "./SshOwnerTransitions.ts";

const makeDatabaseFilename = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "bigbud-ssh-owner-transitions-"))),
  (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
).pipe(Effect.map((directory) => join(directory, "state.sqlite")));

const hydrate = Effect.fn("hydrate")(function* (
  sql: SqlClient.SqlClient,
  expectedPreviousEpoch: string | null,
) {
  const result = yield* rotateSshOwnerWriterAndHydrate(sql, expectedPreviousEpoch);
  if (result.kind !== "hydrated") throw new Error("Expected SSH owner hydration to succeed");
  return result;
});

const targetId = "café/雪";
const newDisconnect = (writerEpoch: string): SshOwnerTransition => ({
  writerEpoch,
  targetId,
  expectedSeq: 0,
  requestId: "disconnect-1",
  desiredState: "disconnected",
});

const flags = (sql: SqlClient.SqlClient) => sql<{ targetId: string; disconnectedAt: number }>`
  SELECT target_id AS targetId, disconnected_at AS disconnectedAt
  FROM remote_execution_target_disconnects ORDER BY target_id`;

const receipts = (sql: SqlClient.SqlClient) => sql<{
  targetId: string;
  seq: number;
  requestId: string;
  digest: string;
}>`SELECT target_id AS targetId, seq, last_request_id AS requestId, last_digest AS digest
   FROM ssh_target_transition ORDER BY target_id`;

it.effect(
  "preserves a pre-migration flag and advances sequences even for already-satisfied states",
  () =>
    Effect.gen(function* () {
      const filename = yield* makeDatabaseFilename;
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* createRemoteExecutionTargetDisconnectsTable(sql);
        yield* sql`INSERT INTO remote_execution_target_disconnects VALUES (${targetId}, 17)`;
        yield* Migration0181;
        assert.deepEqual(yield* rotateSshOwnerWriterAndHydrate(sql, "not-installed"), {
          kind: "epochMismatch",
        });
        const initial = yield* hydrate(sql, null);
        assert.deepEqual(initial.disconnectedTargets, [{ targetId, disconnectedAt: 17 }]);
        assert.deepEqual(initial.sequences, []);
        assert.deepEqual(yield* rotateSshOwnerWriterAndHydrate(sql, null), {
          kind: "epochMismatch",
        });
        const input = newDisconnect(initial.writerEpoch);
        assert.deepEqual(yield* applySshOwnerTransition(sql, input), { kind: "committed", seq: 1 });
        assert.deepEqual(yield* flags(sql), [{ targetId, disconnectedAt: 17 }]);
        const connect = {
          ...input,
          desiredState: "connected",
          expectedSeq: 1,
          requestId: "connect-1",
        } as const;
        assert.deepEqual(yield* applySshOwnerTransition(sql, connect), {
          kind: "committed",
          seq: 2,
        });
        assert.deepEqual(yield* flags(sql), []);
        assert.deepEqual(yield* applySshOwnerTransition(sql, input), { kind: "staleSequence" });
        assert.deepEqual(
          yield* applySshOwnerTransition(sql, {
            ...connect,
            expectedSeq: 2,
            requestId: "connect-2",
          }),
          { kind: "committed", seq: 3 },
        );
        assert.deepEqual(yield* flags(sql), []);
        const rows = yield* receipts(sql);
        assert.lengthOf(rows, 1);
        assert.deepInclude(rows[0], { targetId, seq: 3, requestId: "connect-2" });
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
    }),
);

it.effect("returns a receipt after the commit reply is discarded and the database reopens", () =>
  Effect.gen(function* () {
    const filename = yield* makeDatabaseFilename;
    const input = yield* Effect.gen(function* () {
      yield* Migration0181;
      const sql = yield* SqlClient.SqlClient;
      const { writerEpoch } = yield* hydrate(sql, null);
      const input = newDisconnect(writerEpoch);
      yield* applySshOwnerTransition(sql, input);
      return input;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const committedFlags = yield* flags(sql);
      const committedReceipts = yield* receipts(sql);
      assert.lengthOf(committedFlags, 1);
      assert.deepInclude(committedReceipts[0], { targetId, seq: 1, requestId: input.requestId });
      yield* TestClock.adjust("1 second");
      assert.deepEqual(yield* applySshOwnerTransition(sql, input), { kind: "receipt", seq: 1 });
      for (const conflict of [
        { ...input, desiredState: "connected" } as const,
        { ...input, expectedSeq: 1 },
      ]) {
        assert.deepEqual(yield* applySshOwnerTransition(sql, conflict), {
          kind: "requestConflict",
        });
      }
      assert.deepEqual(yield* flags(sql), committedFlags);
      assert.deepEqual(yield* receipts(sql), committedReceipts);
      assert.deepEqual(
        yield* applySshOwnerTransition(sql, {
          ...input,
          requestId: "disconnect-2",
          expectedSeq: 1,
        }),
        { kind: "committed", seq: 2 },
      );
      assert.deepEqual(yield* flags(sql), committedFlags);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
  }),
);

it.effect(
  "fences the previous handle on rebind and hydrates current flag membership after offline legacy writes",
  () =>
    Effect.gen(function* () {
      const filename = yield* makeDatabaseFilename;
      const boundEpoch = yield* Effect.gen(function* () {
        yield* Migration0181;
        const oldSql = yield* SqlClient.SqlClient;
        const { writerEpoch } = yield* hydrate(oldSql, null);
        const original = newDisconnect(writerEpoch);
        assert.deepEqual(yield* applySshOwnerTransition(oldSql, original), {
          kind: "committed",
          seq: 1,
        });
        return yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rebound = yield* hydrate(sql, writerEpoch);
          assert.notEqual(rebound.writerEpoch, writerEpoch);
          assert.deepEqual(rebound.sequences, [{ targetId, seq: 1 }]);
          assert.deepEqual(rebound.disconnectedTargets, yield* flags(oldSql));
          assert.deepEqual(yield* rotateSshOwnerWriterAndHydrate(oldSql, writerEpoch), {
            kind: "epochMismatch",
          });
          assert.deepEqual(yield* applySshOwnerTransition(oldSql, original), {
            kind: "epochMismatch",
          });
          const connect = {
            ...original,
            desiredState: "connected",
            expectedSeq: 1,
            requestId: "connect",
          } as const;
          assert.deepEqual(yield* applySshOwnerTransition(oldSql, connect), {
            kind: "epochMismatch",
          });
          assert.deepEqual(yield* flags(sql), rebound.disconnectedTargets);
          assert.deepEqual(
            yield* applySshOwnerTransition(sql, { ...connect, writerEpoch: rebound.writerEpoch }),
            { kind: "committed", seq: 2 },
          );
          assert.deepEqual(
            yield* applySshOwnerTransition(oldSql, {
              ...original,
              expectedSeq: 2,
              requestId: "late-disconnect",
            }),
            { kind: "epochMismatch" },
          );
          assert.deepEqual(yield* flags(sql), []);
          return rebound.writerEpoch;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO remote_execution_target_disconnects VALUES (${targetId}, 49), ('legacy-only', 50)`;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rebound = yield* hydrate(sql, boundEpoch);
        assert.notEqual(rebound.writerEpoch, boundEpoch);
        assert.deepEqual(rebound.sequences, [{ targetId, seq: 2 }]);
        assert.deepEqual(rebound.disconnectedTargets, [
          { targetId, disconnectedAt: 49 },
          { targetId: "legacy-only", disconnectedAt: 50 },
        ]);
        assert.deepEqual(
          yield* applySshOwnerTransition(sql, {
            ...newDisconnect(boundEpoch),
            desiredState: "connected",
            expectedSeq: 1,
            requestId: "connect",
          }),
          { kind: "epochMismatch" },
        );
        assert.deepEqual(yield* flags(sql), rebound.disconnectedTargets);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
    }),
);

it.effect(
  "uses the canonical UTF-8 and big-endian digest encoding and rejects unsafe sequence increments",
  () =>
    Effect.gen(function* () {
      const filename = yield* makeDatabaseFilename;
      yield* Effect.gen(function* () {
        yield* Migration0181;
        const sql = yield* SqlClient.SqlClient;
        const { writerEpoch } = yield* hydrate(sql, null);
        const golden = readFileSync(
          new URL("../../../../../protocol/ssh-owner/v1.golden.transitions", import.meta.url),
          "utf8",
        );
        const cases = [
          ["initial_disconnect", "ssh:fixture", 0, "disconnected"],
          ["initial_connect", "ssh:fixture", 0, "connected"],
          ["next_disconnect", "ssh:fixture", 1, "disconnected"],
          ["unicode_target", "ssh:fixture-λ", Number.MAX_SAFE_INTEGER - 1, "disconnected"],
        ] as const;
        for (const [name, targetId, expectedSeq, desiredState] of cases) {
          yield* sql`DELETE FROM ssh_target_transition WHERE target_id = ${targetId}`;
          if (expectedSeq > 0) {
            yield* sql`INSERT INTO ssh_target_transition VALUES (${targetId}, ${expectedSeq}, 'previous', 'previous')`;
          }
          const input = { writerEpoch, targetId, expectedSeq, desiredState, requestId: name };
          assert.deepEqual(yield* applySshOwnerTransition(sql, input), {
            kind: "committed",
            seq: expectedSeq + 1,
          });
          const digest = golden.match(new RegExp(`^${name}\\.sha256=([a-f0-9]{64})$`, "m"))?.[1];
          assert.isDefined(digest, name);
          assert.equal(
            (yield* receipts(sql)).find((row) => row.targetId === targetId)?.digest,
            digest,
            name,
          );
          assert.deepEqual(yield* applySshOwnerTransition(sql, input), {
            kind: "receipt",
            seq: expectedSeq + 1,
          });
        }

        const before = yield* receipts(sql);
        const beforeFlags = yield* flags(sql);
        for (const expectedSeq of [
          Number.MAX_SAFE_INTEGER,
          Number.MAX_SAFE_INTEGER + 1,
          NaN,
          Infinity,
          -1,
          0.5,
        ]) {
          assert.deepEqual(
            yield* applySshOwnerTransition(sql, {
              writerEpoch,
              targetId: "ssh:fixture-λ",
              desiredState: "connected",
              requestId: "invalid",
              expectedSeq,
            }),
            { kind: "invalidSequence" },
          );
        }
        assert.deepEqual(yield* receipts(sql), before);
        assert.deepEqual(yield* flags(sql), beforeFlags);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
    }),
);

it.effect(
  "rolls back the flag on metadata failure and rolls back a rotation when hydration fails",
  () =>
    Effect.gen(function* () {
      const filename = yield* makeDatabaseFilename;
      yield* Effect.gen(function* () {
        yield* Migration0181;
        const sql = yield* SqlClient.SqlClient;
        const { writerEpoch } = yield* hydrate(sql, null);
        const input = newDisconnect(writerEpoch);
        yield* sql`CREATE TRIGGER fail_transition BEFORE INSERT ON ssh_target_transition
        BEGIN SELECT RAISE(ABORT, 'test metadata failure'); END`;
        yield* Effect.flip(applySshOwnerTransition(sql, input));
        assert.deepEqual(yield* flags(sql), []);
        assert.deepEqual(yield* receipts(sql), []);
        yield* sql`DROP TRIGGER fail_transition`;
        assert.deepEqual(yield* applySshOwnerTransition(sql, input), { kind: "committed", seq: 1 });
        yield* sql`UPDATE ssh_target_transition SET seq = 1.5`;
        assert.match(
          (yield* Effect.flip(rotateSshOwnerWriterAndHydrate(sql, writerEpoch))).message,
          /invalid stored/i,
        );
        assert.deepEqual(yield* applySshOwnerTransition(sql, input), { kind: "invalidSequence" });
        yield* sql`UPDATE ssh_target_transition SET seq = 1`;
        assert.deepEqual(yield* applySshOwnerTransition(sql, input), { kind: "receipt", seq: 1 });
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
    }),
);

for (const desiredState of ["connected", "disconnected"] as const) {
  it.effect(`keeps the prior flag and receipt when COMMIT fails for ${desiredState}`, () =>
    Effect.gen(function* () {
      const filename = yield* makeDatabaseFilename;
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* sql`PRAGMA foreign_keys = ON`;
        yield* Migration0181;
        const { writerEpoch } = yield* hydrate(sql, null);
        const seed: SshOwnerTransition = {
          ...newDisconnect(writerEpoch),
          desiredState: desiredState === "connected" ? "disconnected" : "connected",
        };
        assert.deepEqual(yield* applySshOwnerTransition(sql, seed), { kind: "committed", seq: 1 });
        const previousFlags = yield* flags(sql);
        const previousReceipts = yield* receipts(sql);
        const next: SshOwnerTransition = {
          ...seed,
          expectedSeq: 1,
          requestId: "next-transition",
          desiredState,
        };

        // The flag and receipt statements both run. SQLite checks this constraint only at COMMIT.
        yield* sql`CREATE TABLE fixture_parent (id INTEGER PRIMARY KEY)`;
        yield* sql`CREATE TABLE fixture_child (
          parent_id INTEGER REFERENCES fixture_parent(id) DEFERRABLE INITIALLY DEFERRED
        )`;
        yield* sql`CREATE TRIGGER fail_commit AFTER UPDATE ON ssh_target_transition
          BEGIN INSERT INTO fixture_child VALUES (1); END`;
        const failure = yield* Effect.flip(applySshOwnerTransition(sql, next));
        assert.propertyVal(failure.reason.cause, "message", "FOREIGN KEY constraint failed");
        assert.deepEqual(yield* flags(sql), previousFlags);
        assert.deepEqual(yield* receipts(sql), previousReceipts);
        assert.deepEqual(yield* sql`SELECT * FROM fixture_child`, []);

        yield* Effect.gen(function* () {
          const observer = yield* SqlClient.SqlClient;
          assert.deepEqual(yield* flags(observer), previousFlags);
          assert.deepEqual(yield* receipts(observer), previousReceipts);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename, readonly: true })));

        // The same writer can still replay the prior receipt and commit the failed request once.
        assert.deepEqual(yield* applySshOwnerTransition(sql, seed), { kind: "receipt", seq: 1 });
        yield* sql`INSERT INTO fixture_parent VALUES (1)`;
        assert.deepEqual(yield* applySshOwnerTransition(sql, next), { kind: "committed", seq: 2 });
        assert.deepEqual(yield* applySshOwnerTransition(sql, next), { kind: "receipt", seq: 2 });
        assert.deepEqual(yield* applySshOwnerTransition(sql, seed), { kind: "staleSequence" });
        assert.deepEqual(
          (yield* flags(sql)).map((flag) => flag.targetId),
          desiredState === "disconnected" ? [targetId] : [],
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
    }),
  );
}
