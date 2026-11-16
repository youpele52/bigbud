import { it, expect } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Statement from "effect/unstable/sql/Statement";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  resetRetentionTestRows,
  seedRetentionTestThread,
  seedWorktreeLease,
} from "./threadRetention.test.helpers.ts";
import { sweepThreadLeases } from "./threadLeaseSweep.ts";
import { reconcileWorktreeRuntimeLeases } from "./worktreeRuntimeLease.ts";
import { retainedRustTerminalOwnerKey } from "./ownedRustTerminalLease.ts";

const nowMs = Date.parse("2026-11-15T12:00:00Z");
const DEAD_PID = 2 ** 22 + 12345;
const leaseId = "terminal:owned-rust:pane";
const ownerKey = `terminal:${JSON.stringify(["owned-rust", "pane"])}`;

it.layer(SqlitePersistenceMemory)("durable Rust terminal worktree protection", (it) => {
  const setup = Effect.gen(function* () {
    yield* resetRetentionTestRows();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM remote_agent_runtime_owners`;
    yield* seedRetentionTestThread("owned-rust", "2026-01-01T00:00:00Z");
    yield* seedWorktreeLease({
      leaseId,
      threadId: "owned-rust",
      kind: "terminal",
      expiresAt: "2026-01-01T00:00:00Z",
      processId: DEAD_PID,
    });
    return sql;
  });

  for (const state of ["prepared", "may-have-been-sent", "outcome-unknown"]) {
    it.effect(
      `retains expired/dead-PID leases for ${state} ownership until a terminal receipt`,
      () =>
        Effect.gen(function* () {
          const sql = yield* setup;
          const route = { target: `remote-backend:${"a".repeat(32)}`, state };
          yield* sql`INSERT INTO remote_agent_runtime_owners (owner_key, route_json) VALUES (${ownerKey}, ${JSON.stringify(route)})`;
          yield* reconcileWorktreeRuntimeLeases(sql, "terminal");
          yield* sweepThreadLeases(sql, { nowMs });
          expect(
            (yield* sql`SELECT lease_id FROM worktree_runtime_leases WHERE lease_id = ${leaseId}`)
              .length,
          ).toBe(1);
          yield* sql`UPDATE remote_agent_runtime_owners SET route_json = ${JSON.stringify({ ...route, state: "terminal" })} WHERE owner_key = ${ownerKey}`;
          yield* sweepThreadLeases(sql, { nowMs });
          expect(
            (yield* sql`SELECT lease_id FROM worktree_runtime_leases WHERE lease_id = ${leaseId}`)
              .length,
          ).toBe(0);
        }),
    );
  }

  it.effect("preserves a live Rust process after its backend heartbeat expires", () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* sql`UPDATE worktree_runtime_leases SET process_id = ${process.pid} WHERE lease_id = ${leaseId}`;
      yield* sql`INSERT INTO remote_agent_runtime_owners (owner_key, route_json) VALUES (${ownerKey}, ${JSON.stringify({ target: `remote-backend:${"a".repeat(32)}`, state: "may-have-been-sent" })})`;
      yield* sweepThreadLeases(sql, { nowMs });
      expect(
        (yield* sql`SELECT lease_id FROM worktree_runtime_leases WHERE lease_id = ${leaseId}`)
          .length,
      ).toBe(1);
    }),
  );

  it.effect(
    "fails closed on malformed/missing owner identity but keeps historical SSH cleanup unchanged",
    () =>
      Effect.gen(function* () {
        const sql = yield* setup;
        expect(
          yield* sql`INSERT INTO remote_agent_runtime_owners (owner_key, route_json) VALUES (${ownerKey}, 'invalid-json')`.pipe(
            Effect.isFailure,
          ),
        ).toBe(true);
        for (const raw of [
          "{}",
          JSON.stringify({ target: ["remote-backend:bad"], state: "terminal" }),
        ]) {
          yield* sql`INSERT OR REPLACE INTO remote_agent_runtime_owners (owner_key, route_json) VALUES (${ownerKey}, ${raw})`;
          yield* reconcileWorktreeRuntimeLeases(sql, "terminal");
          yield* sweepThreadLeases(sql, { nowMs });
          expect(
            (yield* sql`SELECT lease_id FROM worktree_runtime_leases WHERE lease_id = ${leaseId}`)
              .length,
          ).toBe(1);
        }
        yield* sql`UPDATE remote_agent_runtime_owners SET route_json = ${JSON.stringify({ target: "ssh:host=remote", state: "may-have-been-sent" })} WHERE owner_key = ${ownerKey}`;
        yield* sweepThreadLeases(sql, { nowMs });
        expect(
          (yield* sql`SELECT lease_id FROM worktree_runtime_leases WHERE lease_id = ${leaseId}`)
            .length,
        ).toBe(0);
        expect(
          retainedRustTerminalOwnerKey({
            leaseId: "terminal:t:with:colons",
            threadId: "t",
            runtimeKind: "terminal",
          }),
        ).toBe(`terminal:${JSON.stringify(["t", "with:colons"])}`);
      }),
  );

  for (const operation of ["sweep", "reconcile"] as const) {
    it.effect(`cannot delete a reacquired lease using a stale ${operation} candidate`, () =>
      Effect.gen(function* () {
        const sql = yield* setup;
        let renewed = false;
        const transformer: Statement.Transformer = (statement) => {
          const [query] = statement.compile();
          if (
            renewed ||
            !query.includes("DELETE FROM worktree_runtime_leases") ||
            !query.includes("direct_shell_launch_owners")
          )
            return Effect.succeed(statement);
          renewed = true;
          return sql`UPDATE worktree_runtime_leases SET updated_at = '2026-11-15T12:00:01Z', expires_at = '2026-11-15T12:05:01Z', process_id = ${process.pid} WHERE lease_id = ${leaseId}`.pipe(
            Effect.provideService(Statement.CurrentTransformer, undefined),
            Effect.orDie,
            Effect.as(statement),
          );
        };
        yield* (
          operation === "sweep"
            ? sweepThreadLeases(sql, { nowMs })
            : reconcileWorktreeRuntimeLeases(sql, "terminal")
        ).pipe(Effect.provideService(Statement.CurrentTransformer, transformer));
        expect(renewed).toBe(true);
        const leases = yield* sql<{
          process_id: number;
        }>`SELECT process_id FROM worktree_runtime_leases WHERE lease_id = ${leaseId}`;
        expect(leases).toEqual([{ process_id: process.pid }]);
      }),
    );
  }
});
