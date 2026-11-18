import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  peerDispatchFixture,
  peerUuid,
} from "../../peer-orchestration/peerFixtures.test.helpers.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { PeerDispatchRepository } from "../Services/PeerDispatches.ts";
import { PeerDispatchRepositoryLive } from "./PeerDispatches.ts";

const layer = PeerDispatchRepositoryLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));
const at = (s: number) => `2026-11-18T00:01:${String(s).padStart(2, "0")}.000Z`;
const result = {
  outcome: "completed" as const,
  summary: "done",
  truncated: false,
  attachments: [],
};

it.effect("one dispatch identity creates one row: retries join, collisions conflict", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 175 });
    const dispatches = yield* PeerDispatchRepository;
    const created = yield* dispatches.insert(peerDispatchFixture(1));
    assert.isFalse(created.joined);
    assert.deepStrictEqual(created.dispatch, peerDispatchFixture(1));

    // Same identity again joins the existing row.
    const again = yield* dispatches.insert(peerDispatchFixture(1));
    assert.isTrue(again.joined);
    // A retried request with a fresh dispatch id but the same request key joins the original.
    const retried = yield* dispatches.insert(
      peerDispatchFixture(2, { requestKey: peerDispatchFixture(1).requestKey }),
    );
    assert.isTrue(retried.joined);
    assert.equal(retried.dispatch.dispatchId, peerDispatchFixture(1).dispatchId);

    // Same request key to a different worker target, or a reused dispatch id, conflicts.
    const other = peerDispatchFixture(3, { requestKey: peerDispatchFixture(1).requestKey });
    const differentTarget = yield* Effect.flip(
      dispatches.insert({ ...other, worker: { ...other.worker, provider: "claudeAgent" } }),
    );
    assert.equal(differentTarget._tag, "PeerDispatchConflict");
    const reusedId = yield* Effect.flip(
      dispatches.insert(peerDispatchFixture(1, { requestKey: "invocation-other" })),
    );
    assert.equal(reusedId._tag, "PeerDispatchConflict");
    const notPending = yield* Effect.flip(
      dispatches.insert(peerDispatchFixture(4, { state: "accepted", childThreadId: null })),
    );
    assert.equal(notPending._tag, "PeerDispatchConflict");

    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM peer_dispatches`;
    assert.equal(rows[0]?.n, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect("transitions follow the table, keep one child and durable cancel intent", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 175 });
    const dispatches = yield* PeerDispatchRepository;
    const id = (yield* dispatches.insert(peerDispatchFixture(1))).dispatch.dispatchId;

    const illegal = yield* Effect.flip(
      dispatches.transition(id, "worker-accepted", { updatedAt: at(1), childThreadId: "child" }),
    );
    assert.equal(illegal._tag, "PeerDispatchIllegalTransition");
    assert.isUndefined(yield* dispatches.recordSendRetry(id, at(1)));

    assert.equal(
      (yield* dispatches.transition(id, "send-started", { updatedAt: at(2) }))?.state,
      "sent-uncertain",
    );
    assert.equal((yield* dispatches.recordSendRetry(id, at(3)))?.sendAttempts, 2);
    const missingChild = yield* Effect.flip(
      dispatches.transition(id, "worker-accepted", { updatedAt: at(4) }),
    );
    assert.equal(missingChild._tag, "PeerDispatchConflict");
    const accepted = yield* dispatches.transition(id, "worker-accepted", {
      updatedAt: at(4),
      childThreadId: "child-1",
    });
    assert.equal(accepted?.childThreadId, "child-1");
    yield* dispatches.transition(id, "follow-started", { updatedAt: at(5) });
    const cancelling = yield* dispatches.transition(id, "cancel-requested", { updatedAt: at(6) });
    assert.equal(cancelling?.state, "cancel-pending");
    assert.equal(cancelling?.cancelRequestedAt, at(6));
    // Cancel intent never reverts to following; the child finishing first is the truth.
    const back = yield* Effect.flip(
      dispatches.transition(id, "follow-started", { updatedAt: at(7) }),
    );
    assert.equal(back._tag, "PeerDispatchIllegalTransition");
    const done = yield* dispatches.transition(id, "child-completed", { updatedAt: at(8), result });
    assert.deepStrictEqual(
      [done?.state, done?.result, done?.cancelRequestedAt],
      ["completed", result, at(6)],
    );
    const terminal = yield* Effect.flip(
      dispatches.transition(id, "cancel-confirmed", { updatedAt: at(9) }),
    );
    assert.equal(terminal._tag, "PeerDispatchIllegalTransition");
    const unknown = yield* Effect.flip(
      dispatches.transition(peerUuid(2, 99), "send-started", { updatedAt: at(9) }),
    );
    assert.equal(unknown._tag, "PeerDispatchIllegalTransition");
  }).pipe(Effect.provide(layer)),
);

it.effect("unsettled dispatches are listed for restart resume and the table refuses bad rows", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 175 });
    const dispatches = yield* PeerDispatchRepository;
    for (const n of [1, 2, 3]) yield* dispatches.insert(peerDispatchFixture(n));
    yield* dispatches.transition(peerUuid(2, 1), "cancel-requested", { updatedAt: at(1) });
    yield* dispatches.transition(peerUuid(2, 2), "send-started", { updatedAt: at(2) });
    const failed = yield* dispatches.transition(peerUuid(2, 3), "rejected", {
      updatedAt: at(3),
      error: { code: "grant-revoked", message: "revoked" },
    });
    assert.equal(failed?.error?.code, "grant-revoked");
    const unsettled = yield* dispatches.listUnsettled(10);
    assert.deepStrictEqual(
      unsettled.map((d) => [d.dispatchId, d.state]),
      [[peerUuid(2, 2), "sent-uncertain"]],
    );

    const sql = yield* SqlClient.SqlClient;
    for (const statement of [
      sql`UPDATE peer_dispatches SET state = 'completed' WHERE dispatch_id = ${peerUuid(2, 2)}`,
      sql`UPDATE peer_dispatches SET state = 'cancel-pending', cancel_requested_at = NULL
        WHERE dispatch_id = ${peerUuid(2, 2)}`,
      sql`UPDATE peer_dispatches SET state = 'pending' WHERE dispatch_id = ${peerUuid(2, 2)}`,
    ]) {
      const refused = yield* Effect.flip(statement);
      assert.match(String(refused), /CHECK|constraint/i);
    }
  }).pipe(Effect.provide(layer)),
);
