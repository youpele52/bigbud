import { assert, it } from "@effect/vitest";
import { Effect, Scope } from "effect";
import * as Exit from "effect/Exit";

import { PeerDispatchRepository } from "../persistence/Services/PeerDispatches.ts";
import { peerRequestKey } from "./peerDispatch.delegate.ts";
import { peerResultCommandId } from "./peerDispatch.delivery.ts";
import { makePeerDispatchService } from "./peerDispatch.service.ts";
import {
  CALLER_THREAD,
  FakeThread,
  FakeWorker,
  makePeerTestDeps,
  peerTestLayer,
  seedPairing,
  waitForDispatch,
} from "./peerDispatch.test.helpers.ts";

const delegateInput = (invocationId: string) => ({
  callerThreadId: CALLER_THREAD,
  invocationId,
  task: "Run the test suite and summarize failures.",
});

/** Runs a service in its own scope so a test can "crash" it by closing the scope. */
const startService = Effect.fn("startService")(function* (worker: FakeWorker, thread: FakeThread) {
  const scope = yield* Scope.make();
  const deps = yield* makePeerTestDeps(worker, thread);
  const service = yield* makePeerDispatchService(deps, { toolWaitMs: 500 }).pipe(
    Scope.provide(scope),
  );
  return { service, deps, crash: () => Scope.close(scope, Exit.void) };
});

it.live("uncertain_send_never_relaunches", () =>
  Effect.gen(function* () {
    yield* seedPairing();
    const worker = new FakeWorker();
    const { service, crash } = yield* startService(worker, new FakeThread());

    // The delegate is processed but its reply is lost: the follower probes status only.
    worker.dropReplies.delegate = 1;
    const first = yield* service.delegate(delegateInput("call-1"));
    const dispatchId = String(first.dispatchId);
    const accepted = yield* waitForDispatch(dispatchId, (d) => d.childThreadId !== null);
    assert.strictEqual(worker.count("delegate"), 1);
    assert.strictEqual(worker.launches, 1);
    assert.strictEqual(accepted.sendAttempts, 1);

    // A retried tool call joins the same identity; nothing is re-sent.
    const retried = yield* service.delegate(delegateInput("call-1"));
    assert.strictEqual(retried.dispatchId, dispatchId);
    assert.isTrue(retried.replayed);
    assert.strictEqual(worker.launches, 1);
    assert.strictEqual(worker.count("delegate"), 1);
    yield* crash();
  }).pipe(Effect.provide(peerTestLayer)),
);

it.live("uncertain send re-sends the same identity only after dispatch-unknown", () =>
  Effect.gen(function* () {
    yield* seedPairing();
    const worker = new FakeWorker();
    const { service, crash } = yield* startService(worker, new FakeThread());
    worker.partition = true;
    const first = yield* service.delegate(delegateInput("call-2"));
    const dispatchId = String(first.dispatchId);
    assert.strictEqual(first.state, "sent-uncertain");
    worker.partition = false;
    yield* waitForDispatch(dispatchId, (d) => d.childThreadId !== null);
    // Status said dispatch-unknown, then the stored request went out once more, unchanged.
    const delegates = worker.calls.filter((call) => call.action === "delegate");
    assert.strictEqual(delegates.length, 1);
    assert.strictEqual(delegates[0]!.body.dispatchId, dispatchId);
    assert.strictEqual(worker.count("status") >= 1, true);
    assert.strictEqual(worker.launches, 1);
    const dispatches = yield* PeerDispatchRepository;
    const row = yield* dispatches.findByRequestKey(CALLER_THREAD, peerRequestKey("call-2"));
    assert.strictEqual(row?.dispatchId, dispatchId);
    assert.strictEqual(row?.sendAttempts, 2);
    yield* crash();
  }).pipe(Effect.provide(peerTestLayer)),
);

it.live("restart_resumes_follow", () =>
  Effect.gen(function* () {
    yield* seedPairing();
    const worker = new FakeWorker();
    const thread = new FakeThread();
    const before = yield* startService(worker, thread);
    const first = yield* before.service.delegate(delegateInput("call-3"));
    const dispatchId = String(first.dispatchId);
    yield* waitForDispatch(dispatchId, (d) => d.state === "following");
    yield* before.crash();

    worker.finish(dispatchId, "completed", "All 12 tests pass.");
    const after = yield* startService(worker, thread);
    assert.isAtLeast(yield* after.service.resume(), 1);
    const done = yield* waitForDispatch(dispatchId, (d) => d.state === "completed");
    assert.strictEqual(done.result?.summary, "All 12 tests pass.");
    assert.strictEqual(worker.launches, 1);
    assert.strictEqual(thread.turns.length, 1);
    assert.include(thread.turns[0]!.text, "All 12 tests pass.");
    yield* after.crash();
  }).pipe(Effect.provide(peerTestLayer)),
);

it.live("lost_result_recovered_by_status", () =>
  Effect.gen(function* () {
    yield* seedPairing();
    const worker = new FakeWorker();
    const thread = new FakeThread();
    const { service, crash } = yield* startService(worker, thread);
    // Delegate reply lost and the child finishes before the next probe: status recovers both
    // the child id and, through follow, the result; lost follow replies are simply re-polled.
    worker.dropReplies = { delegate: 1, follow: 2 };
    worker.partition = false;
    const first = yield* service.delegate(delegateInput("call-4"));
    const dispatchId = String(first.dispatchId);
    worker.finish(dispatchId, "completed", "Recovered.");
    const done = yield* waitForDispatch(dispatchId, (d) => d.state === "completed");
    assert.strictEqual(done.childThreadId, `peer-thread:${dispatchId}`);
    assert.strictEqual(done.result?.summary, "Recovered.");
    assert.isAtLeast(worker.count("status"), 1);
    assert.strictEqual(worker.launches, 1);
    assert.strictEqual(thread.turns.length, 1);
    yield* crash();
  }).pipe(Effect.provide(peerTestLayer)),
);

it.live("one_result_delivery_per_identity", () =>
  Effect.gen(function* () {
    yield* seedPairing();
    const worker = new FakeWorker();
    const thread = new FakeThread();
    // First service crashes mid-delivery (after the turn started, before settling).
    thread.hang = true;
    const before = yield* startService(worker, thread);
    const first = yield* before.service.delegate(delegateInput("call-5"));
    const dispatchId = String(first.dispatchId);
    worker.finish(dispatchId, "failed", "Build broke.");
    for (let i = 0; i < 200 && thread.calls.length === 0; i++)
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
    assert.strictEqual(thread.calls.length, 1);
    yield* before.crash();

    // The restarted follower delivers again under the same command id, after one failure.
    thread.hang = false;
    thread.failNext = 1;
    const after = yield* startService(worker, thread);
    yield* after.service.resume();
    const done = yield* waitForDispatch(dispatchId, (d) => d.state === "failed");
    assert.strictEqual(done.error?.code, "child-failed");
    assert.isAtLeast(thread.calls.length, 3);
    for (const call of thread.calls)
      assert.strictEqual(call.commandId, peerResultCommandId(dispatchId));
    assert.strictEqual(thread.turns.length, 1);
    assert.strictEqual(thread.turns[0]!.threadId, CALLER_THREAD);
    yield* after.crash();
  }).pipe(Effect.provide(peerTestLayer)),
);
