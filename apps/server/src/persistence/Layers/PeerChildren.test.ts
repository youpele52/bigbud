import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { OrchestrationThread } from "@bigbud/contracts";
import { PEER_RESULT_SUMMARY_MAX_CHARS } from "@bigbud/contracts/server/remotePeer.ts";

import {
  COORDINATOR_AUTHORITY,
  peerUuid,
} from "../../peer-orchestration/peerFixtures.test.helpers.ts";
import { boundPeerSummary, peerChildStatus } from "../../peer-orchestration/peerWorker.status.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { PeerChildRepository, type PeerChild } from "../Services/PeerChildren.ts";
import { PeerChildRepositoryLive } from "./PeerChildren.ts";

const layer = PeerChildRepositoryLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));

const child = (n: number, overrides: Partial<PeerChild> = {}): PeerChild => {
  const dispatchId = peerUuid(2, n);
  return {
    commandId: `peer:${COORDINATOR_AUTHORITY}:${dispatchId}`,
    dispatchId,
    coordinatorAuthorityId: COORDINATOR_AUTHORITY,
    grantId: peerUuid(1, 1),
    childThreadId: `peer-thread:${n}`,
    requestDigest: "a".repeat(64),
    workspaceRoot: "/srv/work",
    provider: "codex",
    createdAt: `2026-11-18T00:00:0${n}.000Z`,
    cancelRequestedAt: null,
    start: null,
    startCompletedAt: null,
    startFailure: null,
    ...overrides,
  };
};

it.effect("176 records one child per dispatch identity, scoped to its grant", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 175 });
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE name = 'peer_children'`,
      [],
    );
    yield* runMigrations({ toMigrationInclusive: 176 });
    // 179 adds the start intent columns the repository reads.
    yield* runMigrations({ toMigrationInclusive: 179 });
    const children = yield* PeerChildRepository;
    const first = yield* children.claim(child(1));
    assert.isFalse(first.joined);
    // A retry with a later clock joins and keeps the first creation time.
    const again = yield* children.claim(child(1, { createdAt: "2026-11-18T09:00:00.000Z" }));
    assert.isTrue(again.joined);
    assert.equal(again.child.createdAt, child(1).createdAt);
    // A different request or grant under the same identity conflicts.
    const digest = yield* Effect.flip(children.claim(child(1, { requestDigest: "b".repeat(64) })));
    assert.equal(digest._tag, "PeerChildConflict");
    const grant = yield* Effect.flip(children.claim(child(1, { grantId: peerUuid(1, 2) })));
    assert.equal(grant._tag, "PeerChildConflict");
    // Lookups and cancel intent never cross grants; the first cancel time is kept.
    assert.isUndefined(yield* children.findForGrant(peerUuid(1, 2), child(1).commandId));
    assert.isUndefined(
      yield* children.markCancelRequested(
        peerUuid(1, 2),
        child(1).commandId,
        "2026-11-18T01:00:00.000Z",
      ),
    );
    const cancelled = yield* children.markCancelRequested(
      peerUuid(1, 1),
      child(1).commandId,
      "2026-11-18T01:00:00.000Z",
    );
    assert.equal(cancelled?.cancelRequestedAt, "2026-11-18T01:00:00.000Z");
    const twice = yield* children.markCancelRequested(
      peerUuid(1, 1),
      child(1).commandId,
      "2026-11-18T02:00:00.000Z",
    );
    assert.equal(twice?.cancelRequestedAt, "2026-11-18T01:00:00.000Z");
    // The namespaced command id must match its coordinator and dispatch.
    const forged = yield* Effect.flip(
      children.claim(child(3, { commandId: `peer:${"e".repeat(32)}:${peerUuid(2, 3)}` })),
    );
    assert.equal(forged._tag, "PersistenceSqlError");
  }).pipe(Effect.provide(layer)),
);

it("bounds result summaries and reports terminal child states", () => {
  const long = boundPeerSummary("completed", "x".repeat(PEER_RESULT_SUMMARY_MAX_CHARS + 5));
  assert.equal(long.summary.length, PEER_RESULT_SUMMARY_MAX_CHARS);
  assert.isTrue(long.truncated);
  assert.isFalse(boundPeerSummary("failed", "short").truncated);
  const thread = {
    id: "peer-thread:1",
    title: "Child",
    deletedAt: null,
    archivedAt: null,
    interactionMode: "default",
    activities: [],
    proposedPlans: [],
    session: null,
    updatedAt: "2026-11-18T00:00:00.000Z",
    latestTurn: {
      turnId: "turn-1",
      state: "interrupted",
      requestedAt: "2026-11-18T00:00:00.000Z",
      startedAt: "2026-11-18T00:00:00.000Z",
      completedAt: "2026-11-18T00:00:01.000Z",
      assistantMessageId: null,
    },
    messages: [{ role: "assistant", streaming: false, text: "partial work" }],
  } as unknown as OrchestrationThread;
  const status = peerChildStatus(
    { ...child(1), cancelRequestedAt: "2026-11-18T00:00:00.500Z" },
    thread,
  );
  assert.equal(status.state, "cancelled");
  assert.isTrue(status.cancelRequested);
  assert.deepStrictEqual(status.result, {
    outcome: "cancelled",
    summary: "partial work",
    truncated: false,
    attachments: [],
  });
});
