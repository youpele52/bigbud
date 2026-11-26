import { it } from "@effect/vitest";
import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { createRemoteExecutionTargetDisconnectsTable } from "../persistence/RemoteExecutionTargetDisconnects.schema.ts";
import { commitLegacyRetirement } from "../persistence/Layers/LegacyRetirement.ts";
import {
  configureSshOwner,
  resetSshOwnerProductionStateForTest,
  startSshOwnerAfterConfigurationForTest,
} from "./sshOwnerProductionComposition.ts";
import {
  readSshOwnerStartupState,
  startSshOwnerAfterLegacyGate,
} from "./sshOwnerStartupRefusal.ts";
import { runSshOwnerBootSequence, type SshOwnerProductionOwner } from "./sshOwnerProductionBoot.ts";
import {
  readSshOwnerHydrationSnapshot,
  type SshOwnerHydrationSnapshot,
} from "./sshOwnerProductionHydration.ts";
import { assertSshOwnerHydrationAcknowledged } from "./sshOwnerProductionClient.hydration.ts";
import type { PickerProofReconciliation } from "./sshOwnerPickerProof.client.session.types.ts";
import { resolveSshOwnerLaunchFacts } from "./sshOwnerProductionClient.launch.ts";
import { startOrAttachSshOwnerProduction } from "./sshOwnerProductionClient.ts";
import { makeProductionFixture } from "./sshOwnerProductionClient.fixture.ts";

const profile = "state-dir";

const migrated = Effect.gen(function* () {
  yield* runMigrations({ toMigrationInclusive: 185 });
  return yield* SqlClient.SqlClient;
});

const owner: SshOwnerProductionOwner = {
  profile: "desktop-packaged",
  artifactPath: "/owner",
  hydrate: () => Effect.void,
};

const emptySnapshot: SshOwnerHydrationSnapshot = {
  durableDisconnects: [],
  aliasDescriptorBindings: [],
  retirementMirror: [],
  paneBindings: [],
};

function bootInput(
  sql: SqlClient.SqlClient,
  order: string[],
  options: {
    readonly hydrationFails?: boolean;
    readonly admitted?: boolean;
    readonly owner?: SshOwnerProductionOwner;
    readonly snapshot?: SshOwnerHydrationSnapshot;
    readonly reconciliation?: PickerProofReconciliation;
    readonly acknowledgedSnapshot?: SshOwnerHydrationSnapshot;
  } = {},
) {
  const handle = options.owner ?? owner;
  return {
    acquireStateLock: Effect.sync(() => {
      order.push("lock");
    }),
    readState: readSshOwnerStartupState(sql, {
      profileScope: profile,
      ownerPresent: Effect.succeed(true),
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          order.push("marker");
        }),
      ),
    ),
    startOrAttachOwner: Effect.sync(() => {
      order.push("owner");
      return handle;
    }),
    hydrate: (started: SshOwnerProductionOwner) =>
      Effect.suspend(() => {
        order.push("hydrate");
        if (options.hydrationFails) return Effect.fail(new Error("hydration failed"));
        if (options.snapshot === undefined) return started.hydrate(emptySnapshot);
        // The boot gate is the owner's acknowledgement, never the local
        // category check alone.
        if (options.reconciliation === undefined)
          return Effect.fail(new Error("no owner acknowledgement"));
        return Effect.try({
          try: () =>
            assertSshOwnerHydrationAcknowledged({
              snapshot: options.snapshot!,
              storage: undefined,
              aliasDescriptor: undefined,
              ...(options.reconciliation === undefined
                ? {}
                : { reconciliation: options.reconciliation }),
              ...(options.acknowledgedSnapshot === undefined
                ? {}
                : { acknowledgedSnapshot: options.acknowledgedSnapshot }),
            }),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        });
      }),
    openAdmission: () =>
      Effect.sync(() => {
        order.push("admission");
      }),
  };
}

it.effect("refuses a missing marker before any owner start or hydration", () =>
  Effect.gen(function* () {
    const sql = yield* migrated;
    const order: string[] = [];
    let started = 0;
    const outcome = yield* runSshOwnerBootSequence({
      ...bootInput(sql, order),
      startOrAttachOwner: Effect.sync(() => {
        started += 1;
        order.push("owner");
        return owner;
      }),
    });
    assert.equal(outcome.kind, "refused");
    assert.equal(started, 0);
    assert.deepEqual(order, ["lock", "marker"]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("runs marker -> owner attach -> hydrate -> admission in order", () =>
  Effect.gen(function* () {
    const sql = yield* migrated;
    yield* commitLegacyRetirement(sql, {
      profileScope: profile,
      artifactId: "build-a",
      decision: "drain-now",
      drainedLeases: [],
      pendingItems: [],
    });
    const order: string[] = [];
    const outcome = yield* runSshOwnerBootSequence(bootInput(sql, order));
    assert.equal(outcome.kind, "open");
    assert.deepEqual(order, ["lock", "marker", "owner", "hydrate", "admission"]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("keeps admission closed when hydration fails", () =>
  Effect.gen(function* () {
    const sql = yield* migrated;
    yield* commitLegacyRetirement(sql, {
      profileScope: profile,
      artifactId: "build-a",
      decision: "drain-now",
      drainedLeases: [],
      pendingItems: [],
    });
    const order: string[] = [];
    const outcome = yield* runSshOwnerBootSequence(bootInput(sql, order, { hydrationFails: true }));
    assert.equal(outcome.kind, "unavailable");
    if (outcome.kind === "unavailable") {
      assert.equal(outcome.step, "hydrate");
      assert.equal(outcome.error.reason, "hydration-failed");
    }
    assert.isFalse(order.includes("admission"));
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

const unresolvedRetirement = {
  profileScope: profile,
  targetId: "ssh:a",
  ownerEpoch: "",
  generation: "",
  state: "intent" as const,
  pid: null,
  startTime: null,
  namespace: null,
  detail: "pre-spawn",
  updatedAt: 7,
};

it.effect("stays closed and launches nothing when the state lock is not held", () =>
  Effect.gen(function* () {
    const sql = yield* migrated;
    const order: string[] = [];
    const outcome = yield* runSshOwnerBootSequence({
      ...bootInput(sql, order),
      acquireStateLock: Effect.fail(new Error("lock lost")),
    });
    assert.equal(outcome.kind, "unavailable");
    if (outcome.kind === "unavailable") {
      assert.equal(outcome.step, "state-lock");
      assert.equal(outcome.error.reason, "state-lock-failed");
    }
    assert.deepEqual(order, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("never evaluates the owner when the W3.6 state machine refuses", () =>
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
    const started = yield* startSshOwnerAfterLegacyGate({
      readState: Effect.succeed(state),
      startOwner: Effect.sync(() => {
        launches += 1;
        return owner;
      }),
      onRefused: () => Effect.void,
      onUnavailable: () => Effect.void,
    });
    assert.isTrue(Option.isNone(started));
    assert.equal(launches, 0);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("admits on the owner acknowledgement of rows the backend cannot resolve alone", () =>
  Effect.gen(function* () {
    const sql = yield* migrated;
    yield* commitLegacyRetirement(sql, {
      profileScope: profile,
      artifactId: "build-a",
      decision: "drain-now",
      drainedLeases: [],
      pendingItems: [],
    });
    const snapshot: SshOwnerHydrationSnapshot = {
      ...emptySnapshot,
      retirementMirror: [unresolvedRetirement],
    };
    const order: string[] = [];
    const outcome = yield* runSshOwnerBootSequence(
      bootInput(sql, order, {
        snapshot,
        acknowledgedSnapshot: snapshot,
        reconciliation: { acknowledged: true, retirements: 1, panes: 0 },
      }),
    );
    assert.equal(outcome.kind, "open");
    assert.deepEqual(order, ["lock", "marker", "owner", "hydrate", "admission"]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("hydrates all four durable categories", () =>
  Effect.gen(function* () {
    const sql = yield* migrated;
    yield* createRemoteExecutionTargetDisconnectsTable(sql);
    yield* sql`INSERT INTO remote_execution_target_disconnects VALUES ('ssh:a', 7)`;
    yield* sql`INSERT INTO ssh_alias_descriptor_bindings
      VALUES (${profile}, 'ssh:a', 'digest', 7)`;
    yield* sql`INSERT INTO ssh_owner_retirement
      (profile_scope, target_id, owner_epoch, generation, state, pid, start_time, namespace,
        detail, updated_at)
      VALUES (${profile}, 'ssh:a', '', '', 'intent', NULL, NULL, NULL, 'pre-spawn', 7)`;
    yield* sql`INSERT INTO direct_shell_launch_owners
      (owner_key, reservation_id, controller_id, state, owner_json)
      VALUES ('pane-1', 'reservation-1', 'controller-1', 'prepared', '{}')`;
    const snapshot = yield* readSshOwnerHydrationSnapshot(sql, profile);
    assert.deepEqual(snapshot.durableDisconnects, [{ targetId: "ssh:a", disconnectedAt: 7 }]);
    assert.deepEqual(snapshot.aliasDescriptorBindings, [
      { targetId: "ssh:a", descriptorDigest: "digest" },
    ]);
    assert.equal(snapshot.retirementMirror.length, 1);
    assert.equal(snapshot.retirementMirror[0]?.state, "intent");
    assert.deepEqual(snapshot.paneBindings, [
      {
        ownerKey: "pane-1",
        threadId: "",
        terminalId: "",
        ownerEpoch: "",
        targetId: "",
        generation: "",
        leaseId: "reservation-1",
        state: "prepared",
      },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("opens admission with the real production client on the success path", () =>
  Effect.gen(function* () {
    const sql = yield* migrated;
    yield* commitLegacyRetirement(sql, {
      profileScope: profile,
      artifactId: "build-a",
      decision: "drain-now",
      drainedLeases: [],
      pendingItems: [],
    });
    const fixture = yield* Effect.promise(() => makeProductionFixture());
    yield* Effect.addFinalizer(() => Effect.promise(() => fixture.dispose()));
    const path = yield* Effect.promise(() => fixture.fakeOwner("success"));
    const order: string[] = [];
    const outcome = yield* runSshOwnerBootSequence({
      ...bootInput(sql, order),
      // The production client replaces the injected fake owner on this path.
      startOrAttachOwner: startOrAttachSshOwnerProduction({
        artifact: fixture.artifact(path),
        facts: resolveSshOwnerLaunchFacts({
          ...fixture.profile,
          target: { ...fixture.profile.target!, targetId: profile },
          stateDirectory: fixture.stateDirectory,
        }),
        sql,
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            order.push("owner");
          }),
        ),
      ),
    });
    assert.equal(outcome.kind, "open");
    assert.deepEqual(order, ["lock", "marker", "owner", "hydrate", "admission"]);
    if (outcome.kind === "open") yield* outcome.owner.shutdown?.() ?? Effect.void;
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "activation with a derived profile reaches owner start, not owner-profile-unavailable",
  () =>
    Effect.gen(function* () {
      resetSshOwnerProductionStateForTest();
      yield* Effect.addFinalizer(() => Effect.sync(resetSshOwnerProductionStateForTest));
      const sql = yield* migrated;
      yield* commitLegacyRetirement(sql, {
        profileScope: profile,
        artifactId: "build-a",
        decision: "drain-now",
        drainedLeases: [],
        pendingItems: [],
      });
      const fixture = yield* Effect.promise(() => makeProductionFixture());
      yield* Effect.addFinalizer(() => Effect.promise(() => fixture.dispose()));
      const path = yield* Effect.promise(() => fixture.fakeOwner("success"));
      const configuration = yield* configureSshOwner(
        { mode: "desktop", devUrl: undefined, stateDir: fixture.stateDirectory },
        "file:///unused-entry.mjs",
        {
          activation: true,
          artifactOverride: fixture.artifact(path, "desktop-packaged"),
          ownerProfile: { ...fixture.profile, kind: "desktop-packaged" },
        },
      );
      assert.equal(configuration.kind, "configured");
      const handle = yield* startSshOwnerAfterConfigurationForTest(sql);
      assert.equal(handle.mode, "spawned");
      assert.equal(handle.state(), "open");
      const observation = yield* Effect.promise(() => fixture.observation());
      assert.equal(observation.argv[2], "--production");
      assert.match(String(observation.argv[4]), /^bbso1:desktop-packaged:[0-9a-f]{64}$/);
      yield* handle.shutdown();
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
