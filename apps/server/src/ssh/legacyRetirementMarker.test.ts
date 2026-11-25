import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  commitLegacyRetirement,
  readLegacyRetirement,
  readLegacyRetirementMarker,
} from "../persistence/Layers/LegacyRetirement.ts";
import { runLegacyDrain, type LegacyDrainPane } from "./sshLegacyDrain.ts";

const profile = "state-dir";
const input = {
  profileScope: profile,
  artifactId: "build-a-1.0.0",
  decision: "drain-now" as const,
  drainedLeases: ["ssh:one:lease-1"],
  pendingItems: [] as string[],
};

const migrated = Effect.gen(function* () {
  yield* runMigrations({ toMigrationInclusive: 185 });
  return yield* SqlClient.SqlClient;
});

it.effect("writes the record and marker in one transaction and is idempotent", () =>
  Effect.gen(function* () {
    const sql = yield* migrated;
    assert.equal(yield* commitLegacyRetirement(sql, input), "committed");
    const written = yield* readLegacyRetirement(sql, profile);
    assert.equal(written?.marker.artifactId, input.artifactId);
    assert.deepEqual(written?.record.drainedLeases, input.drainedLeases);
    assert.deepEqual(written?.record.pendingItems, []);
    assert.equal(yield* commitLegacyRetirement(sql, input), "already-retired");
    assert.equal(
      (yield* sql`SELECT count(*) AS count FROM ssh_legacy_retired_marker`)[0]?.count,
      1,
    );
    // A different A artifact after retirement is a conflict and changes nothing.
    assert.equal(
      yield* commitLegacyRetirement(sql, { ...input, artifactId: "build-a-2.0.0" }),
      "conflict",
    );
    assert.equal((yield* readLegacyRetirementMarker(sql, profile))?.artifactId, input.artifactId);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("rolls the record back when the marker insert fails", () =>
  Effect.gen(function* () {
    const sql = yield* migrated;
    yield* sql`
      CREATE TRIGGER reject_marker BEFORE INSERT ON ssh_legacy_retired_marker
      BEGIN SELECT RAISE(ABORT, 'marker rejected'); END
    `;
    const result = yield* Effect.exit(commitLegacyRetirement(sql, input));
    assert.isTrue(result._tag === "Failure");
    assert.deepEqual(yield* sql`SELECT * FROM ssh_legacy_retirement`, []);
    assert.deepEqual(yield* sql`SELECT * FROM ssh_legacy_retired_marker`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("checkpoints the WAL before returning from the commit", () =>
  Effect.gen(function* () {
    const directory = mkdtempSync(path.join(tmpdir(), "bigbud-legacy-retirement-"));
    const filename = path.join(directory, "backend.sqlite");
    try {
      yield* Effect.gen(function* () {
        const sql = yield* migrated;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* commitLegacyRetirement(sql, input);
        // TRUNCATE leaves no frames behind once the only writer has committed.
        const wal = `${filename}-wal`;
        assert.equal(existsSync(wal) ? statSync(wal).size : 0, 0);
        assert.isDefined(yield* readLegacyRetirementMarker(sql, profile));
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }),
);

const pane = (overrides: Partial<LegacyDrainPane> = {}): LegacyDrainPane => ({
  paneId: "terminal-1",
  threadId: "thread-1",
  threadTitle: "Parser work",
  title: "ssh fixture",
  surface: "direct-ssh",
  leaseId: "lease-1",
  keepMode: false,
  ...overrides,
});

it.effect("releases the lock only after the marker commit and checkpoints last", () =>
  Effect.gen(function* () {
    const sql = yield* migrated;
    const events: string[] = [];
    const outcome = yield* runLegacyDrain({
      trigger: "updater",
      profileScope: profile,
      artifactId: input.artifactId,
      stopMonitors: Effect.sync(() => events.push("monitors")),
      stopRelays: Effect.sync(() => events.push("relays")),
      stopProviders: Effect.sync(() => events.push("providers")),
      listPanes: Effect.succeed([pane()]),
      consent: () => Effect.succeed({ kind: "proceed", choice: "drain-now" }),
      closePane: (closed) => Effect.sync(() => events.push(`close:${closed.leaseId}`)),
      closeOwnedMasters: Effect.sync(() => {
        events.push("masters");
        return { closed: 1, failed: 0 };
      }),
      commit: (record) =>
        commitLegacyRetirement(sql, record).pipe(
          Effect.tap(() => Effect.sync(() => events.push("commit"))),
        ),
      releaseLock: Effect.sync(() => events.push("release")),
    });
    assert.equal(outcome.kind, "drained");
    assert.deepEqual(events, [
      "monitors",
      "relays",
      "providers",
      "close:lease-1",
      "masters",
      "commit",
      "release",
    ]);
    assert.isDefined(yield* readLegacyRetirementMarker(sql, profile));
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("refuses a different A artifact after retirement and keeps the lock", () =>
  Effect.gen(function* () {
    const sql = yield* migrated;
    yield* commitLegacyRetirement(sql, input);
    let released = 0;
    const result = yield* Effect.exit(
      runLegacyDrain({
        trigger: "updater",
        profileScope: profile,
        artifactId: "different-build-a",
        stopMonitors: Effect.void,
        stopRelays: Effect.void,
        stopProviders: Effect.void,
        listPanes: Effect.succeed([]),
        consent: () => Effect.succeed({ kind: "proceed", choice: "drain-now" }),
        closePane: () => Effect.void,
        closeOwnedMasters: Effect.succeed({ closed: 0, failed: 0 }),
        commit: (record) => commitLegacyRetirement(sql, record),
        releaseLock: Effect.sync(() => {
          released += 1;
        }),
      }),
    );
    assert.isTrue(result._tag === "Failure");
    assert.equal(released, 0);
    assert.equal((yield* readLegacyRetirementMarker(sql, profile))?.artifactId, input.artifactId);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("writes no marker and releases no lock when the commit crashes", () =>
  Effect.gen(function* () {
    const sql = yield* migrated;
    let released = 0;
    const result = yield* Effect.exit(
      runLegacyDrain({
        trigger: "installer",
        profileScope: profile,
        artifactId: input.artifactId,
        stopMonitors: Effect.void,
        stopRelays: Effect.void,
        stopProviders: Effect.void,
        listPanes: Effect.succeed([pane()]),
        consent: () => Effect.succeed({ kind: "proceed", choice: "save-and-close" }),
        closePane: () => Effect.void,
        closeOwnedMasters: Effect.succeed({ closed: 0, failed: 0 }),
        commit: () => Effect.die(new Error("crash before marker")),
        releaseLock: Effect.sync(() => {
          released += 1;
        }),
      }),
    );
    assert.isTrue(result._tag === "Failure");
    assert.equal(released, 0);
    assert.isUndefined(yield* readLegacyRetirementMarker(sql, profile));
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
