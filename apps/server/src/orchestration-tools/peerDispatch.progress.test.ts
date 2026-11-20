import { assert, it } from "@effect/vitest";
import { Effect, Scope } from "effect";
import * as Exit from "effect/Exit";

import {
  COORDINATOR_AUTHORITY,
  peerDispatchFixture,
  peerUuid,
} from "../peer-orchestration/peerFixtures.test.helpers.ts";
import {
  decodePeerChildStatus,
  peerChildProgress,
  peerChildProgressView,
} from "./peerDispatch.progress.ts";
import { makePeerDispatchService, type PeerToolResult } from "./peerDispatch.service.ts";
import {
  CALLER_THREAD,
  FakeThread,
  FakeWorker,
  makePeerTestDeps,
  peerTestLayer,
  seedPairing,
  waitForDispatch,
} from "./peerDispatch.test.helpers.ts";

const AT = "2026-11-19T00:00:00.000Z";

interface ChildView {
  readonly state: string;
  readonly workflowStatus: string;
  readonly waiting?: { readonly reason: string; readonly approvalKind?: string };
  readonly guidance?: string;
}

const startDelegated = Effect.fn("startDelegated")(function* (invocationId: string) {
  yield* seedPairing();
  const worker = new FakeWorker();
  const scope = yield* Scope.make();
  const deps = yield* makePeerTestDeps(worker, new FakeThread());
  const service = yield* makePeerDispatchService(deps, { toolWaitMs: 500 }).pipe(
    Scope.provide(scope),
  );
  const delegated = yield* service.delegate({
    callerThreadId: CALLER_THREAD,
    invocationId,
    task: "Apply the migration on the worker.",
  });
  const dispatchId = String(delegated.dispatchId);
  yield* waitForDispatch(dispatchId, (d) => d.state === "following");
  const child = worker.children.get(dispatchId)!;
  /** Polls the status tool until the reported child progress satisfies `done`. */
  const statusUntil = Effect.fn("statusUntil")(function* (done: (child?: ChildView) => boolean) {
    const deadline = Date.now() + 3_000;
    for (;;) {
      const view: PeerToolResult = yield* service.status({
        callerThreadId: CALLER_THREAD,
        dispatchId,
      });
      if (done(view.child as ChildView | undefined)) return view;
      if (Date.now() > deadline) throw new Error(`status stuck: ${JSON.stringify(view)}`);
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
    }
  });
  return {
    worker,
    deps,
    dispatchId,
    child,
    statusUntil,
    close: () => Scope.close(scope, Exit.void),
  };
});

it.live("peer_dispatch_status shows the worker child waiting for an approval", () =>
  Effect.gen(function* () {
    const { worker, deps, dispatchId, child, statusUntil, close } =
      yield* startDelegated("call-wait");
    child.state = "waiting";
    child.workflowStatus = "awaiting_approval";
    child.waiting = { reason: "approval-pending", approvalKind: "command" };
    const waiting = yield* statusUntil((view) => view?.state === "waiting");
    const view = waiting.child as ChildView;
    assert.strictEqual(waiting.state, "following");
    assert.strictEqual(view.workflowStatus, "awaiting_approval");
    assert.deepStrictEqual(view.waiting, { reason: "approval-pending", approvalKind: "command" });
    assert.include(view.guidance, "an approval of a command on the worker host");

    // Answered on the worker: back to running, without a stale reason.
    child.state = "running";
    child.workflowStatus = "working";
    child.waiting = undefined;
    const running = (yield* statusUntil((v) => v?.state === "running")).child as ChildView;
    assert.isUndefined(running.waiting);
    assert.isUndefined(running.guidance);

    // A settled dispatch reports its result, not live progress.
    worker.finish(dispatchId, "completed", "Migrated.");
    yield* waitForDispatch(dispatchId, (d) => d.state === "completed");
    const done = yield* statusUntil((v) => v === undefined);
    assert.strictEqual(done.state, "completed");
    assert.isFalse(deps.childProgress.has(dispatchId));
    yield* close();
  }).pipe(Effect.provide(peerTestLayer)),
);

it.live("a previous-protocol worker's waiting child still reads as waiting", () =>
  Effect.gen(function* () {
    const { child, statusUntil, close } = yield* startDelegated("call-legacy");
    // Old workers send `state: "waiting"` and the workflow label, but no `waiting` detail.
    child.state = "waiting";
    child.workflowStatus = "awaiting_input";
    const view = (yield* statusUntil((v) => v?.state === "waiting")).child as ChildView;
    assert.deepStrictEqual(view.waiting, { reason: "user-input-pending" });
    assert.include(view.guidance, "an answer to its question");
    yield* close();
  }).pipe(Effect.provide(peerTestLayer)),
);

it.live("a child the worker stops reporting drops its live progress with the row", () =>
  Effect.gen(function* () {
    const { worker, deps, dispatchId, child, statusUntil, close } =
      yield* startDelegated("call-refused");
    child.state = "waiting";
    child.waiting = { reason: "approval-pending" };
    yield* statusUntil((view) => view?.state === "waiting");
    // The worker forgets the child: the final refusal settles the row without a child status.
    worker.children.delete(dispatchId);
    yield* waitForDispatch(dispatchId, (d) => d.state === "failed");
    yield* statusUntil((view) => view === undefined);
    for (let i = 0; i < 200 && deps.childProgress.has(dispatchId); i++)
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
    assert.isFalse(deps.childProgress.has(dispatchId));
    yield* close();
  }).pipe(Effect.provide(peerTestLayer)),
);

it("never shows live progress for a settled dispatch", () => {
  const progress = {
    state: "waiting" as const,
    workflowStatus: "awaiting_approval",
    waiting: { reason: "approval-pending" as const },
    observedAt: AT,
  };
  const live = peerDispatchFixture(1, { state: "following" });
  const store = new Map([[live.dispatchId, progress]]);
  assert.strictEqual(peerChildProgressView(store, live)?.state, "waiting");
  assert.isUndefined(peerChildProgressView(store, { ...live, state: "failed" }));
});

const reply = (extra: Record<string, unknown>) => {
  const dispatchId = peerUuid(2, 9);
  return {
    dispatchId,
    commandId: `peer:${COORDINATOR_AUTHORITY}:${dispatchId}`,
    childThreadId: "peer-child-9",
    state: "running",
    workflowStatus: "working",
    cancelRequested: false,
    result: null,
    ...extra,
  };
};

it("drops an undecodable waiting detail instead of the whole reply (newer worker)", () => {
  const status = decodePeerChildStatus(
    reply({ state: "waiting", workflowStatus: "paused", waiting: { reason: "paused" } }),
  );
  assert.isDefined(status);
  assert.isUndefined(status!.waiting);
  assert.deepStrictEqual(peerChildProgress(status!, AT), {
    state: "waiting",
    workflowStatus: "paused",
    waiting: null,
    observedAt: AT,
  });
  assert.isUndefined(decodePeerChildStatus(reply({ state: "sleeping" })));
});

it("treats absent or unknown waiting information on a non-waiting child as running", () => {
  const absent = decodePeerChildStatus(reply({}))!;
  assert.strictEqual(peerChildProgress(absent, AT).state, "running");
  const stray = decodePeerChildStatus(reply({ waiting: { reason: "approval-pending" } }))!;
  assert.deepStrictEqual(peerChildProgress(stray, AT), {
    state: "running",
    workflowStatus: "working",
    waiting: null,
    observedAt: AT,
  });
});
