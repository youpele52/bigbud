import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { commitLegacyRetirement } from "../persistence/Layers/LegacyRetirement.ts";
import { DatabaseSchemaNewerThanRuntimeError } from "../persistence/Migrations.downgradeGuard.ts";
import {
  LegacyEntryFencedError,
  SSH_LEGACY_ENTRY_FENCED_CODE,
  makeSshLegacyStartupGate,
  readSshOwnerStartupState,
  startSshOwnerAfterLegacyGate,
} from "./sshOwnerStartupRefusal.ts";

const profile = "state-dir";
const migrated = Effect.gen(function* () {
  yield* runMigrations({ toMigrationInclusive: 185 });
  return yield* SqlClient.SqlClient;
});

it.effect("fences a startup with no retirement marker and launches no SSH", () =>
  Effect.gen(function* () {
    const sql = yield* migrated;
    let launches = 0;
    let fenced: LegacyEntryFencedError | undefined;
    const state = yield* readSshOwnerStartupState(sql, {
      profileScope: profile,
      ownerPresent: Effect.succeed(true),
    });
    assert.equal(state.kind, "refused");
    if (state.kind === "refused") {
      fenced = state.error;
      assert.equal(state.error.code, SSH_LEGACY_ENTRY_FENCED_CODE);
      assert.equal(state.error.reason, "retirement-marker-missing");
    }
    const started = yield* startSshOwnerAfterLegacyGate({
      readState: Effect.succeed(state),
      startOwner: Effect.sync(() => {
        launches += 1;
        return "owner";
      }),
      onRefused: (error) =>
        Effect.sync(() => {
          fenced = error;
        }),
      onUnavailable: () => Effect.void,
    });
    assert.isTrue(Option.isNone(started));
    assert.equal(launches, 0);
    assert.equal(fenced?.code, "legacyEntryFenced");
    // Distinct from the two other startup states the UI must separate.
    const schema = new DatabaseSchemaNewerThanRuntimeError({
      appliedMigrationId: 999,
      appliedMigrationName: "future",
      latestKnownMigrationId: 185,
    });
    assert.notEqual(schema._tag, fenced?._tag);
    assert.notEqual(state.kind, "ssh-unavailable");
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("admits a valid marker with a present owner", () =>
  Effect.gen(function* () {
    const sql = yield* migrated;
    yield* commitLegacyRetirement(sql, {
      profileScope: profile,
      artifactId: "build-a",
      decision: "drain-now",
      drainedLeases: [],
      pendingItems: [],
    });
    let launches = 0;
    const state = yield* readSshOwnerStartupState(sql, {
      profileScope: profile,
      ownerPresent: Effect.succeed(true),
    });
    assert.equal(state.kind, "admitted");
    const started = yield* startSshOwnerAfterLegacyGate({
      readState: Effect.succeed(state),
      startOwner: Effect.sync(() => {
        launches += 1;
        return "owner";
      }),
      onRefused: () => Effect.void,
      onUnavailable: () => Effect.void,
    });
    assert.isTrue(Option.isSome(started));
    assert.equal(launches, 1);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("fences a partially drained marker and still launches no SSH", () =>
  Effect.gen(function* () {
    const sql = yield* migrated;
    yield* commitLegacyRetirement(sql, {
      profileScope: profile,
      artifactId: "build-a",
      decision: "save-and-close",
      drainedLeases: [],
      pendingItems: ["thread-2:terminal-4"],
    });
    let launches = 0;
    const state = yield* readSshOwnerStartupState(sql, {
      profileScope: profile,
      ownerPresent: Effect.succeed(true),
    });
    assert.equal(state.kind, "refused");
    if (state.kind === "refused") assert.equal(state.error.reason, "legacy-panes-pending");
    yield* startSshOwnerAfterLegacyGate({
      readState: Effect.succeed(state),
      startOwner: Effect.sync(() => {
        launches += 1;
      }),
      onRefused: () => Effect.void,
      onUnavailable: () => Effect.void,
    });
    assert.equal(launches, 0);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("reports a -sshOwnerUnavailable- owner loss after a valid marker, not a fence", () =>
  Effect.gen(function* () {
    const sql = yield* migrated;
    yield* commitLegacyRetirement(sql, {
      profileScope: profile,
      artifactId: "build-a",
      decision: "drain-now",
      drainedLeases: [],
      pendingItems: [],
    });
    let launches = 0;
    const state = yield* readSshOwnerStartupState(sql, {
      profileScope: profile,
      ownerPresent: Effect.succeed(false),
    });
    assert.equal(state.kind, "ssh-unavailable");
    if (state.kind === "ssh-unavailable") {
      assert.equal(state.error.code, "sshOwnerUnavailable");
      assert.equal(state.error.reason, "owner-missing");
    }
    yield* startSshOwnerAfterLegacyGate({
      readState: Effect.succeed(state),
      startOwner: Effect.sync(() => {
        launches += 1;
      }),
      onRefused: () => Effect.void,
      onUnavailable: () => Effect.void,
    });
    assert.equal(launches, 0);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("offers the drain action without running it during startup", () =>
  Effect.gen(function* () {
    const state = {
      kind: "refused",
      error: new LegacyEntryFencedError("retirement-marker-missing"),
    } as const;
    let drains = 0;
    const gate = makeSshLegacyStartupGate({
      state,
      drainIdentified: () =>
        Effect.sync(() => {
          drains += 1;
        }),
    });
    assert.equal(drains, 0);
    const admission = yield* Effect.exit(gate.assertSshAdmission);
    assert.isTrue(admission._tag === "Failure");
    assert.equal(drains, 0);
    yield* gate.drainIdentified();
    assert.equal(drains, 1);
  }),
);
