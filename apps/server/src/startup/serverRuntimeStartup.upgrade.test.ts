import { assert, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Layer, Option, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { vi } from "vitest";

const writeStartupStatus = vi.hoisted(() => vi.fn());
vi.mock("./startupStatus.ts", () => ({ writeStartupStatus }));

import { GitCore } from "../git/Services/GitCore.ts";
import { worktreeFailure } from "../git/Layers/WorktreeInventory.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { rebuildTableSql } from "../persistence/Migrations/MigrationTableRebuild.ts";
import { ServerLifecycleEvents } from "./serverLifecycleEvents.ts";
import { ServerRuntimeStartup } from "./serverRuntimeStartup.ts";
import { startupLayer } from "./serverRuntimeStartup.test.fixtures.ts";

it.effect(
  "upgrades already-applied legacy 130/131 before worktree recovery and reaches ready",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 131 });
        // Reproduce the development schema that had already been recorded as applied.
        yield* sql.withTransaction(
          rebuildTableSql(
            sql,
            "worktree_operations",
            (ddl) => ddl.replace("'rename', 'delete', 'create', 'access'", "'rename', 'delete'"),
            {
              children: [
                "worktree_operation_items",
                "worktree_provider_relocations",
                "worktree_provider_lineage",
              ],
            },
          ),
        );
        for (const column of ["parent_path", "parent_device", "parent_inode"]) {
          yield* sql.unsafe(`ALTER TABLE worktree_operations DROP COLUMN ${column}`);
        }
        yield* sql`INSERT INTO worktree_operations (
        operation_id, request_digest, kind, repository, cwd, source_path, destination_path,
        canonical_path, device, inode, phase, created_at
      ) VALUES ('legacy-pending', 'digest', 'rename', '/fixture/.git', '/fixture',
        '/fixture/old', '/fixture/new', '/fixture/old', 1, 2, 'prepared', 'now')`;
        yield* sql`INSERT INTO worktree_operation_items
        VALUES ('legacy-pending','retained-thread','/fixture/old','/fixture/new','command',0)`;
        const items = yield* sql`SELECT * FROM worktree_operation_items`;
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(sql`SELECT parent_path FROM worktree_operations`)),
        );
        assert.deepEqual(
          (yield* runMigrations()).filter(([id]) => id === 132),
          [[132, "RepairWorktreeOperationSchema"]],
        );

        const execute = vi.fn(() =>
          Effect.fail(worktreeFailure("/fixture", "Disposable fixture has no live repository.")),
        );
        writeStartupStatus.mockClear();
        yield* Effect.gen(function* () {
          const startup = yield* ServerRuntimeStartup;
          const lifecycle = yield* ServerLifecycleEvents;
          const ready = yield* lifecycle.stream.pipe(
            Stream.filter((event) => event.type === "ready"),
            Stream.runHead,
            Effect.forkScoped,
          );
          yield* startup.awaitCommandReady;
          yield* startup.markHttpListening;
          assert.isTrue(Option.isSome(yield* Fiber.join(ready)));
          assert.deepEqual(writeStartupStatus.mock.calls, [["ready"]]);
          // Superseded relocation operations are fenced for manual review, never retried through Git.
          assert.equal(execute.mock.calls.length, 0);
        }).pipe(
          Effect.provide(
            startupLayer(
              [],
              undefined,
              undefined,
              undefined,
              undefined,
              Layer.merge(
                Layer.succeed(SqlClient.SqlClient, sql),
                Layer.mock(GitCore)({ execute }),
              ),
            ),
          ),
        );

        assert.deepEqual(yield* sql`SELECT * FROM worktree_operation_items`, items);
        assert.deepEqual(
          yield* sql`SELECT phase,parent_path,parent_device,parent_inode FROM worktree_operations`,
          [
            {
              phase: "recovery-required",
              parent_path: null,
              parent_device: null,
              parent_inode: null,
            },
          ],
        );
        assert.deepEqual(yield* runMigrations(), []);
        assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
        assert.deepEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
    ),
);
