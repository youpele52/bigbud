import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import Migration0181 from "../Migrations/181_SshOwnerTransitions.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import {
  applySshOwnerTransition,
  rotateSshOwnerWriterAndHydrate,
  type SshOwnerTransition,
} from "./SshOwnerTransitions.ts";

const makeDatabaseFilename = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "bigbud-ssh-owner-race-"))),
  (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
).pipe(Effect.map((directory) => join(directory, "state.sqlite")));

const targetId = "ssh:race-fixture";

const hydrate = Effect.fn("hydrate")(function* (
  sql: SqlClient.SqlClient,
  previousEpoch: string | null,
) {
  const result = yield* rotateSshOwnerWriterAndHydrate(sql, previousEpoch);
  if (result.kind !== "hydrated") throw new Error("Expected SSH owner hydration to succeed");
  return result;
});

const readTarget = Effect.fn("readTarget")(function* (sql: SqlClient.SqlClient) {
  const flags = yield* sql<{ targetId: string; disconnectedAt: number }>`
    SELECT target_id AS targetId, disconnected_at AS disconnectedAt
    FROM remote_execution_target_disconnects ORDER BY target_id`;
  const receipts = yield* sql<{ targetId: string; seq: number; requestId: string; digest: string }>`
    SELECT target_id AS targetId, seq, last_request_id AS requestId, last_digest AS digest
    FROM ssh_target_transition ORDER BY target_id`;
  return { flags, receipts };
});

for (const { delayedState, winningState } of [
  { delayedState: "connected", winningState: "disconnected" },
  { delayedState: "disconnected", winningState: "connected" },
] as const) {
  it.effect(
    `fences an already pending ${delayedState} write after a newer ${winningState} write`,
    () =>
      Effect.gen(function* () {
        const filename = yield* makeDatabaseFilename;
        yield* Effect.gen(function* () {
          yield* Migration0181;
          const oldSql = yield* SqlClient.SqlClient;
          const { writerEpoch } = yield* hydrate(oldSql, null);
          const expectedSeq = winningState === "connected" ? 1 : 0;
          if (expectedSeq === 1) {
            assert.deepEqual(
              yield* applySshOwnerTransition(oldSql, {
                writerEpoch,
                targetId,
                expectedSeq: 0,
                requestId: "seed-disconnect",
                desiredState: "disconnected",
              }),
              { kind: "committed", seq: 1 },
            );
          }
          const delayed: SshOwnerTransition = {
            writerEpoch,
            targetId,
            expectedSeq,
            requestId: "delayed",
            desiredState: delayedState,
          };

          yield* Effect.gen(function* () {
            const newSql = yield* SqlClient.SqlClient;
            assert.notStrictEqual(newSql, oldSql);
            const reserved = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const holder = yield* Effect.gen(function* () {
              yield* oldSql.reserve;
              yield* Deferred.succeed(reserved, undefined);
              yield* Deferred.await(release);
            }).pipe(Effect.scoped, Effect.forkScoped);
            yield* Deferred.await(reserved);

            // Start the real adapter now. It queues on its connection before BEGIN IMMEDIATE.
            const pending = yield* applySshOwnerTransition(oldSql, delayed).pipe(
              Effect.forkScoped({ startImmediately: true }),
            );
            assert.isUndefined(pending.pollUnsafe());

            const rebound = yield* hydrate(newSql, writerEpoch);
            assert.notEqual(rebound.writerEpoch, writerEpoch);
            const seq = expectedSeq + 1;
            assert.deepEqual(
              yield* applySshOwnerTransition(newSql, {
                ...delayed,
                writerEpoch: rebound.writerEpoch,
                requestId: "winner",
                desiredState: winningState,
              }),
              { kind: "committed", seq },
            );
            const committed = yield* readTarget(newSql);
            assert.deepEqual(
              committed.flags.map((flag) => flag.targetId),
              winningState === "disconnected" ? [targetId] : [],
            );
            assert.lengthOf(committed.receipts, 1);
            assert.deepInclude(committed.receipts[0], { targetId, seq, requestId: "winner" });
            assert.isUndefined(pending.pollUnsafe());

            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(holder);
            assert.deepEqual(yield* Fiber.join(pending), { kind: "epochMismatch" });
            assert.deepEqual(yield* readTarget(oldSql), committed);
            assert.deepEqual(yield* readTarget(newSql), committed);
          }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layer({ filename })));
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
      }),
  );
}

it.effect("rehydrates a committed disconnect without its reply and fences the previous epoch", () =>
  Effect.gen(function* () {
    const filename = yield* makeDatabaseFilename;
    const input = yield* Effect.gen(function* () {
      yield* Migration0181;
      const sql = yield* SqlClient.SqlClient;
      const { writerEpoch } = yield* hydrate(sql, null);
      const input: SshOwnerTransition = {
        writerEpoch,
        targetId,
        expectedSeq: 0,
        requestId: "lost-disconnect",
        desiredState: "disconnected",
      };
      const settled = yield* Deferred.make<void, SqlError>();
      const reply = yield* applySshOwnerTransition(sql, input).pipe(
        Effect.onExit((exit) => Deferred.done(settled, Exit.asVoid(exit))),
        // Storage has settled, but the caller never receives the reply.
        Effect.flatMap((result) => Effect.as(Effect.never, result)),
        Effect.forkScoped,
      );
      yield* Deferred.await(settled);
      assert.isUndefined(reply.pollUnsafe());
      yield* Fiber.interrupt(reply);
      return input;
    }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layer({ filename })));

    // The first layer has closed its connection; open the same file under a new binding.
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rebound = yield* hydrate(sql, input.writerEpoch);
      assert.notEqual(rebound.writerEpoch, input.writerEpoch);
      assert.deepEqual(rebound.sequences, [{ targetId, seq: 1 }]);
      const committed = yield* readTarget(sql);
      assert.deepEqual(rebound.disconnectedTargets, committed.flags);
      assert.deepEqual(
        committed.flags.map((flag) => flag.targetId),
        [targetId],
      );
      assert.lengthOf(committed.receipts, 1);
      assert.deepInclude(committed.receipts[0], { targetId, seq: 1, requestId: input.requestId });

      // Neither the old receipt nor a sequence-correct old writer can act after rotation.
      assert.deepEqual(yield* applySshOwnerTransition(sql, input), { kind: "epochMismatch" });
      assert.deepEqual(
        yield* applySshOwnerTransition(sql, {
          ...input,
          expectedSeq: 1,
          requestId: "stale-connect-after-reopen",
          desiredState: "connected",
        }),
        { kind: "epochMismatch" },
      );
      assert.deepEqual(yield* readTarget(sql), committed);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
  }),
);
