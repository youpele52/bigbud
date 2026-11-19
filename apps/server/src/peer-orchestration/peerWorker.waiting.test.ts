import type { OrchestrationThread, OrchestrationThreadActivity } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import type { PeerChild } from "../persistence/Services/PeerChildren.ts";
import { COORDINATOR_AUTHORITY, peerGrantFixture, peerUuid } from "./peerFixtures.test.helpers.ts";
import { peerWorkerFollow } from "./peerWorker.follow.ts";
import type { PeerWorkerDeps } from "./peerWorker.read.ts";
import { peerChildStatus } from "./peerWorker.status.ts";

const AT = "2026-11-19T00:00:00.000Z";
const SECRET = "rm -rf /srv/work/private-notes";
const dispatchId = peerUuid(2, 1);

const child: PeerChild = {
  commandId: `peer:${COORDINATOR_AUTHORITY}:${dispatchId}`,
  dispatchId,
  coordinatorAuthorityId: COORDINATOR_AUTHORITY,
  grantId: peerUuid(1, 1),
  childThreadId: "peer-child-1",
  requestDigest: "0".repeat(64),
  workspaceRoot: "/srv/work",
  provider: "codex",
  createdAt: AT,
  cancelRequestedAt: null,
  start: null,
  startCompletedAt: AT,
  startFailure: null,
};

const activity = (
  sequence: number,
  kind: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity =>
  ({
    id: `activity-${sequence}`,
    tone: "approval",
    kind,
    summary: kind,
    payload,
    turnId: "turn-1",
    sequence,
    createdAt: AT,
  }) as OrchestrationThreadActivity;

/** A child whose turn is running; `activities` decide whether it waits. */
const thread = (activities: ReadonlyArray<OrchestrationThreadActivity>) =>
  ({
    id: "peer-child-1",
    title: "Delegated",
    archivedAt: null,
    deletedAt: null,
    interactionMode: "default",
    messages: [],
    proposedPlans: [],
    activities,
    pendingTurnStart: null,
    queuedPrompts: [],
    updatedAt: AT,
    session: {
      threadId: "peer-child-1",
      status: "running",
      providerName: "codex",
      runtimeMode: "approval-required",
      activeTurnId: "turn-1",
      reason: null,
      lastError: null,
      updatedAt: AT,
    },
    latestTurn: {
      turnId: "turn-1",
      state: "running",
      requestedAt: AT,
      startedAt: AT,
      completedAt: null,
      assistantMessageId: null,
    },
  }) as unknown as OrchestrationThread;

const approval = (sequence: number, requestId: string, requestKind?: string) =>
  activity(sequence, "approval.requested", {
    requestId,
    ...(requestKind ? { requestKind } : {}),
    detail: SECRET,
  });

it("reports waiting with the approval kind when the child awaits an approval", () => {
  const status = peerChildStatus(child, thread([approval(1, "req-1", "command")]));
  assert.strictEqual(status.state, "waiting");
  assert.strictEqual(status.workflowStatus, "awaiting_approval");
  assert.deepStrictEqual(status.waiting, { reason: "approval-pending", approvalKind: "command" });
  // Only the kind crosses the peer boundary, never the approval's detail.
  assert.isFalse(JSON.stringify(status).includes(SECRET));
});

it("names the most recent open approval and omits an unknown kind", () => {
  const open = peerChildStatus(
    child,
    thread([
      approval(1, "req-1", "command"),
      approval(2, "req-2", "file-change"),
      approval(3, "req-3", "file-read"),
      activity(4, "approval.resolved", { requestId: "req-3" }),
    ]),
  );
  assert.deepStrictEqual(open.waiting, {
    reason: "approval-pending",
    approvalKind: "file-change",
  });
  const unknownKind = peerChildStatus(child, thread([approval(1, "req-1", "browser")]));
  assert.deepStrictEqual(unknownKind.waiting, { reason: "approval-pending" });
});

it("reports a pending question as waiting for user input", () => {
  const status = peerChildStatus(
    child,
    thread([activity(1, "user-input.requested", { requestId: "q-1", questions: [SECRET] })]),
  );
  assert.strictEqual(status.state, "waiting");
  assert.deepStrictEqual(status.waiting, { reason: "user-input-pending" });
  assert.isFalse(JSON.stringify(status).includes(SECRET));
});

it("has no waiting detail once the approval is answered", () => {
  const status = peerChildStatus(
    child,
    thread([
      approval(1, "req-1", "command"),
      activity(2, "approval.resolved", { requestId: "req-1" }),
    ]),
  );
  assert.strictEqual(status.state, "running");
  assert.isUndefined(status.waiting);
});

it.live("follow replies as soon as the child starts waiting, not at the poll deadline", () =>
  Effect.gen(function* () {
    let current = thread([]);
    const deps = {
      engine: { ensureThreadState: () => Effect.succeed(current) },
      children: { findByCommand: () => Effect.succeed(child) },
      starter: { kick: () => Effect.void },
    } as unknown as PeerWorkerDeps;
    setTimeout(() => {
      current = thread([approval(1, "req-1", "file-change")]);
    }, 300);
    const started = Date.now();
    const status = yield* peerWorkerFollow(deps, peerGrantFixture(1), dispatchId, 20_000);
    assert.strictEqual(status.state, "waiting");
    assert.deepStrictEqual(status.waiting, {
      reason: "approval-pending",
      approvalKind: "file-change",
    });
    assert.isBelow(Date.now() - started, 5_000);
  }),
);
