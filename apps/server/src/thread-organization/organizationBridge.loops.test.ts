import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { insertProjectionThreadParent } from "../persistence/Layers/ProjectionThread.test.helpers.ts";
import {
  makeOrganizationHeartbeat,
  makeOrganizationObservationPass,
  ORGANIZATION_BRIDGE_TIMING as T,
  type OrganizationNativeLiveness,
} from "./organizationBridge.loops.ts";
import { OrganizationResync } from "./organizationLifecycle.ts";
import { OrganizationObservation } from "./organizationObservation.ts";
import type { OrganizationOwner } from "./organizationOwner.ts";
import type { OrganizationFrame } from "./organizationProtocol.ts";

const owner = (): OrganizationOwner => ({
  backendNonce: "owner",
  generation: 1,
  active: true,
  observedAtMs: 0,
  policy: { version: 1, fingerprint: "policy" },
  idleNotBeforeMs: 0,
  rows: new Map(),
});
const liveness = (ready: boolean): OrganizationNativeLiveness => ({
  ready,
  launchedAt: 0,
  progressAt: 0,
  lastNativeAt: 0,
});

it.effect("heartbeat sends the written fact sequence and reports sleep/wake as one resync", () =>
  Effect.gen(function* () {
    let clock = 0;
    const sent: OrganizationFrame[] = [];
    const resyncs: Error[] = [];
    const live = liveness(true);
    const state = { sequence: 7, frontier: 0 };
    const beatOwner = owner();
    const beat = makeOrganizationHeartbeat({
      owner: beatOwner,
      liveness: live,
      state,
      now: () => clock,
      send: (frame) => Effect.sync(() => void sent.push(frame)),
      resync: (error) => void resyncs.push(error),
    });
    clock = 1000;
    live.lastNativeAt = 1000;
    yield* beat;
    assert.deepEqual(sent.at(-1), {
      backendNonce: "owner",
      generation: 1,
      type: "heartbeat",
      value: { sequence: 7 },
    });
    assert.equal(beatOwner.observedAtMs, 1000);
    clock += T.discontinuityMs + 1;
    yield* beat;
    assert.equal(resyncs.length, 1);
    assert.instanceOf(resyncs[0], OrganizationResync);
    const backwards = makeOrganizationHeartbeat({
      owner: owner(),
      liveness: live,
      state,
      now: () => clock,
      send: () => Effect.void,
      resync: (error) => void resyncs.push(error),
    });
    clock -= 5;
    yield* backwards;
    assert.equal(resyncs.length, 2);
    assert.instanceOf(resyncs[1], OrganizationResync);
  }),
);

it.effect("a resync deferred behind a slow proposal keeps heartbeats flowing to Rust", () =>
  Effect.gen(function* () {
    let clock = 1000;
    let beats = 0;
    const resyncs: Error[] = [];
    const live = liveness(true);
    live.lastNativeAt = 1000;
    const beatOwner = owner();
    const beat = makeOrganizationHeartbeat({
      owner: beatOwner,
      liveness: live,
      state: { sequence: 3, frontier: 0 },
      now: () => clock,
      send: () => Effect.sync(() => void (beats += 1)),
      resync: (error) => void resyncs.push(error),
    });
    yield* beat;
    beatOwner.observedAtMs = 1000;
    // Sleep/wake while a proposal is in flight: the gate defers the resync.
    clock += T.discontinuityMs + 1;
    for (let second = 0; second <= T.nativeSilenceMs / 1000 + 5; second++) {
      yield* beat;
      clock += 1000;
    }
    // One resync, every second still beats (Rust's 15s owner timeout never trips), and the
    // owner sample time stays frozen so acceptance refuses proposals until the resync.
    assert.equal(resyncs.length, 1);
    assert.equal(beats, 1 + T.nativeSilenceMs / 1000 + 6);
    assert.equal(beatOwner.observedAtMs, 1000);
  }),
);

it.effect("native silence and activation budgets are real faults, aligned with Rust", () =>
  Effect.gen(function* () {
    let clock = 0;
    const pending = liveness(false);
    const activation = makeOrganizationHeartbeat({
      owner: owner(),
      liveness: pending,
      state: { sequence: 1, frontier: 0 },
      now: () => clock,
      send: () => Effect.die("no heartbeat before ready"),
      resync: () => assert.fail("activation timing is not a clock discontinuity"),
    });
    for (const at of [5000, 9000]) {
      clock = at;
      pending.progressAt = at - 1000;
      yield* activation;
    }
    clock = 9000 + T.activationProgressMs + 1;
    const stalled = yield* Effect.flip(activation);
    assert.notInstanceOf(stalled, OrganizationResync);
    const ready = liveness(true);
    clock = 0;
    const silent = makeOrganizationHeartbeat({
      owner: owner(),
      liveness: ready,
      state: { sequence: 1, frontier: 0 },
      now: () => clock,
      send: () => Effect.void,
      resync: () => assert.fail("silence is not a clock discontinuity"),
    });
    clock = T.nativeSilenceMs + 1;
    assert.notInstanceOf(yield* Effect.flip(silent), OrganizationResync);
  }),
);

it.effect("a blocked observation never starves the independent heartbeat", () =>
  Effect.gen(function* () {
    const observations = new OrganizationObservation();
    observations.mark("slow");
    const live = liveness(true);
    live.lastNativeAt = Date.now();
    const pass = makeOrganizationObservationPass({
      sql: undefined as unknown as SqlClient.SqlClient,
      liveness: live,
      observations,
      captureOverflowed: Effect.succeed(false),
      refresh: () => Effect.never,
      now: () => 0,
    });
    const blocked = yield* Effect.forkChild(pass);
    let beats = 0;
    const beat = makeOrganizationHeartbeat({
      owner: owner(),
      liveness: live,
      state: { sequence: 1, frontier: 0 },
      send: () => Effect.sync(() => void (beats += 1)),
      resync: () => assert.fail("no discontinuity"),
    });
    yield* beat;
    yield* beat;
    assert.equal(beats, 2);
    yield* Fiber.interrupt(blocked);
  }),
);

it.effect("observation passes are bounded and the membership sweep runs every 15s", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    for (let index = 0; index < 40; index++)
      yield* insertProjectionThreadParent({
        sql,
        threadId: ThreadId.makeUnsafe(`sweep-${index.toString().padStart(2, "0")}`),
        createdAt: "2026-11-01T00:00:00.000Z",
      });
    let clock = 0;
    const refreshed: string[] = [];
    const observations = new OrganizationObservation();
    let overflowed = false;
    const pass = makeOrganizationObservationPass({
      sql,
      liveness: liveness(true),
      observations,
      captureOverflowed: Effect.sync(() => overflowed),
      now: () => clock,
      refresh: (id) => Effect.sync(() => void refreshed.push(id)),
    });
    yield* pass;
    assert.equal(refreshed.length, 0);
    clock = T.sweepMs;
    yield* pass;
    assert.equal(refreshed.length, T.refreshBudget);
    yield* pass;
    assert.equal(refreshed.length, 40);
    yield* pass;
    assert.equal(refreshed.length, 40);
    // A slow refresh is cut off by the 200ms per-pass budget.
    for (let index = 0; index < 10; index++) observations.mark(`slow-${index}`);
    const slow = makeOrganizationObservationPass({
      sql,
      liveness: liveness(true),
      observations,
      captureOverflowed: Effect.succeed(false),
      now: () => clock,
      refresh: () => Effect.sync(() => void (clock += 60)),
    });
    yield* slow;
    assert.equal(observations.size, 6);
    overflowed = true;
    assert.instanceOf(yield* Effect.flip(pass), OrganizationResync);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("a finished sweep re-observes published threads that left the membership", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* insertProjectionThreadParent({
      sql,
      threadId: ThreadId.makeUnsafe("kept"),
      createdAt: "2026-11-01T00:00:00.000Z",
    });
    const observations = new OrganizationObservation();
    const refreshed: string[] = [];
    // "dropped" was deleted while the observation set was full: its mark was lost.
    const pass = makeOrganizationObservationPass({
      sql,
      liveness: liveness(true),
      observations,
      captureOverflowed: Effect.succeed(false),
      now: () => 0,
      refresh: (id) => Effect.sync(() => void refreshed.push(id)),
      published: () => ["dropped", "kept"],
    });
    observations.rescan = true;
    yield* pass;
    assert.deepEqual(refreshed.toSorted(), ["dropped", "kept"]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
