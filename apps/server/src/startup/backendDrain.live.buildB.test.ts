import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  commitLegacyRetirement,
  LEGACY_RETIREMENT_PROFILE_SCOPE,
  readLegacyRetirement,
} from "../persistence/Layers/LegacyRetirement.ts";
import { readOwnerBuildRetirement } from "../persistence/Layers/OwnerBuildRetirement.ts";
import { commitOwnerBuildDrain, makeLiveBackendDrainHandler } from "./backendDrain.live.ts";

// W6 regressions found on the packaged B: its upgrade drain rewrote the legacy marker under
// its own artifact, which conflicts with Build A's marker, and answered an empty message.

type Deps = Parameters<typeof makeLiveBackendDrainHandler>[0];

const handlerFor = (
  commit: Deps["commit"],
  closeOwnedMasters: Deps["closeOwnedMasters"] = Effect.succeed({ closed: 0, failed: 0 }),
) =>
  makeLiveBackendDrainHandler({
    profileScope: LEGACY_RETIREMENT_PROFILE_SCOPE,
    artifactId: "bigbud-server@0.5.0",
    listPanes: () => Effect.succeed([]),
    closePane: () => Effect.void,
    stopMonitors: Effect.void,
    stopRelays: Effect.void,
    stopProviders: Effect.void,
    closeOwnedMasters,
    commit,
    releaseLock: Effect.void,
  });

const request = {
  v: 1,
  token: "a".repeat(64),
  method: "drain",
  artifactId: "bigbud-server@0.5.0",
  consent: "non-interactive",
  waitMs: 5_000,
} as const;

it.layer(NodeSqliteClient.layerMemory())("Build B upgrade drain", (it) => {
  it.effect("drains after Build A retired the profile and leaves A's marker unchanged", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 187 });
      const sql = yield* SqlClient.SqlClient;
      yield* commitLegacyRetirement(sql, {
        profileScope: "backend",
        artifactId: "bigbud-server@0.4.1-beta.1",
        decision: "drain-now",
        drainedLeases: [],
        pendingItems: [],
      });
      const before = yield* readLegacyRetirement(sql, "backend");
      const response = yield* Effect.promise(() =>
        handlerFor((input) => commitOwnerBuildDrain(sql, input))(request),
      );
      assert.deepInclude(response, { ok: true, status: "drained" });
      assert.deepEqual(yield* readLegacyRetirement(sql, "backend"), before);
    }),
  );

  it.effect("commits B's own retirement record with the owner's shutdown report", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 187 });
      const sql = yield* SqlClient.SqlClient;
      const before = yield* readLegacyRetirement(sql, "backend");
      const owner = Effect.succeed({
        closed: 1,
        failed: 0,
        leases: 2,
        attachCleared: true,
        ownerEpoch: "0a0b",
      });
      const response = yield* Effect.promise(() =>
        handlerFor((input) => commitOwnerBuildDrain(sql, input), owner)(request),
      );
      assert.deepInclude(response, { ok: true, status: "drained" });
      const record = yield* readOwnerBuildRetirement(sql, "backend");
      assert.deepInclude(record, {
        artifactId: "bigbud-server@0.5.0",
        decision: "drain-now",
        ownerEpoch: "0a0b",
      });
      assert.deepEqual(record?.drainedLeases, []);
      assert.deepEqual(record?.owner, { masters: 1, leases: 2, attachCleared: true });
      assert.deepEqual(yield* readLegacyRetirement(sql, "backend"), before);
    }),
  );

  it.effect("never writes a marker on a profile that is still fenced", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 187 });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM ssh_legacy_retired_marker`;
      yield* sql`DELETE FROM ssh_legacy_retirement`;
      const response = yield* Effect.promise(() =>
        handlerFor((input) => commitOwnerBuildDrain(sql, input))(request),
      );
      assert.deepInclude(response, { ok: true, status: "drained" });
      assert.equal(yield* readLegacyRetirement(sql, "backend"), undefined);
    }),
  );

  it.effect("answers the drain failure's detail instead of an empty message", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        handlerFor(() => Effect.succeed("conflict" as const))(request),
      );
      assert.equal(response.ok, false);
      if (!response.ok) {
        assert.equal(response.error.code, "failed");
        assert.match(response.error.message, /already retired this profile/);
      }
    }),
  );
});
