import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  peerCeiling,
  peerDispatchFixture,
  peerGrantFixture,
} from "../../peer-orchestration/peerFixtures.test.helpers.ts";
import { PeerGrantRepositoryLive } from "../Layers/PeerGrants.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { PeerGrantRepository } from "../Services/PeerGrants.ts";

const layer = PeerGrantRepositoryLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));

it.effect("175 creates the peer grant and dispatch tables on upgrade", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 174 });
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE name IN ('peer_grants', 'peer_dispatches')`,
      [],
    );
    yield* runMigrations({ toMigrationInclusive: 175 });
    const tables = (yield* sql<{ name: string }>`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'peer_%' ORDER BY name`).map((row) => row.name);
    assert.deepStrictEqual(tables, ["peer_dispatches", "peer_grants"]);
    const indexes = (yield* sql<{ name: string }>`SELECT name FROM sqlite_master
      WHERE type = 'index' AND name LIKE 'peer_%' ORDER BY name`).map((row) => row.name);
    assert.includeMembers(indexes, [
      "peer_dispatches_child",
      "peer_dispatches_unsettled",
      "peer_grants_active_coordinator",
    ]);

    // The namespaced command id is enforced by the table itself, not only by the schema.
    const d = peerDispatchFixture(1);
    const mismatched = yield* Effect.flip(
      sql`INSERT INTO peer_dispatches (dispatch_id, command_id, coordinator_authority_id,
          coordinator_thread_id, request_key, worker_authority_id, grant_id, workspace_root,
          provider, permissions_json, state, created_at, updated_at)
        VALUES (${d.dispatchId}, ${"peer:other"}, ${d.coordinatorAuthorityId},
          ${d.coordinatorThreadId}, ${d.requestKey}, ${d.worker.workerAuthorityId},
          ${d.worker.grantId}, ${d.worker.workspaceRoot}, ${d.worker.provider}, '{}', 'pending',
          ${d.createdAt}, ${d.updatedAt})`,
    );
    assert.match(String(mismatched), /CHECK|constraint/i);
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 175 }), []);
  }).pipe(Effect.provide(layer)),
);

it.effect("grants supersede per coordinator, revoke once and never exceed the local ceiling", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 175 });
    const grants = yield* PeerGrantRepository;

    const first = yield* grants.issue({ grant: peerGrantFixture(1), localCeiling: peerCeiling });
    assert.deepStrictEqual(first, peerGrantFixture(1));
    const second = yield* grants.issue({ grant: peerGrantFixture(2), localCeiling: peerCeiling });
    assert.equal(
      (yield* grants.findActiveForCoordinator(first.coordinatorAuthorityId))?.grantId,
      second.grantId,
    );
    assert.equal((yield* grants.get(first.grantId))?.revokedAt, second.issuedAt);

    // A wider grant than the worker's own ceiling is refused and stores nothing.
    for (const ceiling of [
      { ...peerCeiling, runtimeMode: "full-access" as const },
      { ...peerCeiling, providers: ["pi" as const] },
      { ...peerCeiling, workspaceRoots: ["/"] },
    ]) {
      const refused = yield* Effect.flip(
        grants.issue({ grant: peerGrantFixture(3, { ceiling }), localCeiling: peerCeiling }),
      );
      assert.equal(refused._tag, "PeerGrantExceedsCeiling");
    }
    assert.isUndefined(yield* grants.get(peerGrantFixture(3).grantId));

    const revoked = yield* grants.revoke(second.grantId, "2026-11-18T01:00:00.000Z");
    assert.equal(revoked?.revokedAt, "2026-11-18T01:00:00.000Z");
    const again = yield* grants.revoke(second.grantId, "2026-11-18T02:00:00.000Z");
    assert.equal(again?.revokedAt, "2026-11-18T01:00:00.000Z");
    assert.isUndefined(yield* grants.findActiveForCoordinator(first.coordinatorAuthorityId));
    assert.isUndefined(yield* grants.revoke(peerGrantFixture(9).grantId, "x"));
  }).pipe(Effect.provide(layer)),
);
