import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { readSshOwnerStartupState } from "../../ssh/sshOwnerStartupRefusal.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import {
  commitLegacyRetirement,
  LEGACY_RETIREMENT_PROFILE_SCOPE as scope,
  readLegacyRetirement,
} from "./LegacyRetirement.ts";
import {
  commitOwnerBuildRetirement,
  OWNER_BUILD_RETIREMENT_TARGET,
  readOwnerBuildRetirement,
} from "./OwnerBuildRetirement.ts";
import { listUnresolvedSshOwnerRetirements } from "./SshOwnerRetirement.ts";

const migratedWithLegacyMarker = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 187 });
  yield* commitLegacyRetirement(sql, {
    profileScope: scope,
    artifactId: "bigbud-server@0.4.1-beta.2",
    decision: "drain-now",
    drainedLeases: ["x2:default"],
    pendingItems: [],
  });
  return sql;
});

const input = {
  profileScope: scope,
  artifactId: "bigbud-server@0.4.1-nightly.1",
  decision: "drain-now",
  drainedLeases: ["thread-1:term-1"],
  ownerEpoch: "c0ffee",
  owner: { masters: 1, leases: 0, attachCleared: true },
} as const;

// Each case gets its own database so marker presence never leaks between cases.
const fresh = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

describe("Build B retirement record", () => {
  it.effect("commits B's record without touching A's marker or the unresolved mirror", () =>
    fresh(
      Effect.gen(function* () {
        const sql = yield* migratedWithLegacyMarker;
        const legacyBefore = yield* readLegacyRetirement(sql, scope);
        assert.equal(yield* commitOwnerBuildRetirement(sql, input), "committed");

        const record = yield* readOwnerBuildRetirement(sql, scope);
        assert.deepInclude(record, {
          artifactId: input.artifactId,
          decision: "drain-now",
          ownerEpoch: "c0ffee",
        });
        assert.deepEqual(record?.drainedLeases, ["thread-1:term-1"]);
        assert.deepEqual(record?.owner, input.owner);
        assert.deepEqual(yield* readLegacyRetirement(sql, scope), legacyBefore);
        // A retired row never reaches the hydration mirror, the only reader A′ and B share.
        assert.deepEqual(yield* listUnresolvedSshOwnerRetirements(sql, scope), []);
        const [wal] = yield* sql<{ readonly busy: number }>`PRAGMA wal_checkpoint(PASSIVE)`;
        assert.equal(wal?.busy ?? 0, 0);
      }),
    ),
  );

  it.effect("a later B startup still admits on A's marker with B's record present", () =>
    fresh(
      Effect.gen(function* () {
        const sql = yield* migratedWithLegacyMarker;
        yield* commitOwnerBuildRetirement(sql, input);
        const state = yield* readSshOwnerStartupState(sql, {
          profileScope: scope,
          ownerPresent: Effect.succeed(true),
        });
        assert.equal(state.kind, "admitted");
      }),
    ),
  );

  it.effect("a later B startup without A's marker is still refused", () =>
    fresh(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 187 });
        yield* commitOwnerBuildRetirement(sql, input);
        const state = yield* readSshOwnerStartupState(sql, {
          profileScope: scope,
          ownerPresent: Effect.succeed(true),
        });
        assert.equal(state.kind, "refused");
      }),
    ),
  );

  it.effect("a re-drain replaces the record with the newer drain", () =>
    fresh(
      Effect.gen(function* () {
        const sql = yield* migratedWithLegacyMarker;
        yield* commitOwnerBuildRetirement(sql, input);
        yield* commitOwnerBuildRetirement(sql, {
          ...input,
          drainedLeases: [],
          ownerEpoch: "",
          owner: undefined,
        });
        const record = yield* readOwnerBuildRetirement(sql, scope);
        assert.deepEqual(record?.drainedLeases, []);
        assert.equal(record?.ownerEpoch, "");
        assert.equal(record?.owner, undefined);
      }),
    ),
  );

  it.effect("never replaces an unresolved row that holds the reserved key", () =>
    fresh(
      Effect.gen(function* () {
        const sql = yield* migratedWithLegacyMarker;
        yield* sql`INSERT INTO ssh_owner_retirement
        (profile_scope, target_id, owner_epoch, generation, state, pid, start_time, namespace,
          detail, updated_at)
        VALUES (${scope}, ${OWNER_BUILD_RETIREMENT_TARGET}, '', '', 'intent', NULL, NULL, NULL,
          'pre-spawn', 7)`;
        const exit = yield* Effect.exit(commitOwnerBuildRetirement(sql, input));
        assert.isTrue(Exit.isFailure(exit));
        assert.equal(yield* readOwnerBuildRetirement(sql, scope), undefined);
        assert.equal((yield* listUnresolvedSshOwnerRetirements(sql, scope)).length, 1);
      }),
    ),
  );

  it.effect("refuses a malformed record instead of guessing", () =>
    fresh(
      Effect.gen(function* () {
        const sql = yield* migratedWithLegacyMarker;
        yield* commitOwnerBuildRetirement(sql, input);
        yield* sql`UPDATE ssh_owner_retirement SET detail = '{"v":2}'
        WHERE target_id = ${OWNER_BUILD_RETIREMENT_TARGET}`;
        const exit = yield* Effect.exit(readOwnerBuildRetirement(sql, scope));
        assert.isTrue(Exit.isFailure(exit));
      }),
    ),
  );
});
