import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { makeOrganizationPublisher } from "./organizationBridge.publisher.ts";
import { OrganizationResync } from "./organizationLifecycle.ts";
import { OrganizationObservation } from "./organizationObservation.ts";
import type { OrganizationFrame, OrganizationRow } from "./organizationProtocol.ts";

const row = (factVersion: number): OrganizationRow => ({
  threadId: "thread",
  factVersion,
  organizationRevision: 0,
  section: 2,
  work: 1,
  actionable: false,
  attentionWatermark: 0,
  snoozeIdentity: "",
  eligible: true,
  inScope: true,
  manualAttentionWatermark: 0,
});
type Observed = Parameters<typeof makeOrganizationPublisher>[0]["observe"] extends (
  ...args: never[]
) => Effect.Effect<infer A, unknown, unknown>
  ? A
  : never;

const harness = (script: Observed[], failWrites = false) =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    const sent: OrganizationFrame[] = [];
    const observations = new OrganizationObservation();
    const rows = new Map<string, OrganizationRow>();
    const publisher = makeOrganizationPublisher({
      sql,
      epoch: { backendNonce: "owner", generation: 1 },
      graceMs: () => 300000,
      rows,
      observations,
      observe: () => Effect.sync(() => script.shift()!),
      send: (frame) =>
        failWrites
          ? Effect.fail(new Error("write failed"))
          : Effect.sync(() => void sent.push(frame)),
      initial: { sequence: 1, frontier: 20 },
    });
    return { sql, sent, observations, rows, publisher };
  });

it.effect("a frontier race re-marks the thread instead of failing; frontiers stay monotonic", () =>
  Effect.gen(function* () {
    const { sent, observations, publisher } = yield* harness([
      { status: "stale" },
      { status: "applied", frontier: 30, row: row(1) },
      { status: "unchanged", frontier: 25, row: row(1) },
      { status: "applied", frontier: 25, row: row(2) },
    ]);
    yield* publisher.refresh("thread");
    assert.equal(sent.length, 0);
    assert.equal(observations.take(), "thread");
    yield* publisher.refresh("thread");
    yield* publisher.refresh("thread");
    yield* publisher.refresh("thread");
    assert.deepEqual(
      sent.map(
        (frame) => frame.type === "fact" && [frame.value.sequence, frame.value.sourceFrontier],
      ),
      [
        [2, 30],
        [3, 30],
      ],
    );
    assert.deepEqual(publisher.state, { sequence: 3, frontier: 30 });
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("the heartbeat sequence never advances past a write that did not complete", () =>
  Effect.gen(function* () {
    const { publisher } = yield* harness([{ status: "applied", frontier: 21, row: row(1) }], true);
    yield* Effect.flip(publisher.refresh("thread"));
    assert.equal(publisher.state.sequence, 1);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("deletion publishes a tombstone; disappearance without one is a routine resync", () =>
  Effect.gen(function* () {
    const { sql, sent, rows, publisher } = yield* harness([
      { status: "missing", frontier: 40, row: undefined },
      { status: "missing", frontier: 41, row: undefined },
    ]);
    rows.set("thread", row(3));
    yield* sql`INSERT INTO thread_organization_runtime_threads (thread_id, fact_version, source_frontier,
      transition_digest, attention_watermark, deleted) VALUES ('thread', 4, 40, 'canonical-deletion', 0, 1)`;
    yield* publisher.refresh("thread");
    assert.deepEqual(sent.at(-1), {
      backendNonce: "owner",
      generation: 1,
      type: "fact",
      value: { sequence: 2, sourceFrontier: 40, row: row(4), deleted: true },
    });
    rows.set("thread", row(5));
    yield* sql`UPDATE thread_organization_runtime_threads SET deleted = 0 WHERE thread_id = 'thread'`;
    assert.instanceOf(yield* Effect.flip(publisher.refresh("thread")), OrganizationResync);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
