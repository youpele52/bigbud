import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

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

const sleep = (ms: number) => Effect.promise(() => new Promise((r) => setTimeout(r, ms)));

const setup = Effect.fn("setup")(function* (worker: FakeWorker, thread = new FakeThread()) {
  yield* seedPairing();
  const deps = yield* makePeerTestDeps(worker, thread);
  const service = yield* makePeerDispatchService(deps, { toolWaitMs: 500 });
  return { service, deps, thread };
});

const delegate = (invocationId: string) => ({
  callerThreadId: CALLER_THREAD,
  invocationId,
  task: "Refactor the parser.",
});

it.live("partition_shows_cancel_pending", () =>
  Effect.gen(function* () {
    const worker = new FakeWorker();
    const { service, thread } = yield* setup(worker);
    const first = yield* service.delegate(delegate("cancel-1"));
    const dispatchId = String(first.dispatchId);
    yield* waitForDispatch(dispatchId, (d) => d.state === "following");

    worker.partition = true;
    const cancelled = yield* service.cancel({ callerThreadId: CALLER_THREAD, dispatchId });
    assert.strictEqual(cancelled.state, "cancel-pending");
    // Silence is not cancellation: during the partition the row stays cancel-pending.
    yield* sleep(150);
    const during = yield* service.status({ callerThreadId: CALLER_THREAD, dispatchId });
    assert.strictEqual(during.state, "cancel-pending");
    assert.isString(during.cancelRequestedAt);
    assert.strictEqual(worker.count("cancel"), 0);

    worker.partition = false;
    const done = yield* waitForDispatch(dispatchId, (d) => d.state === "cancelled");
    assert.strictEqual(done.result?.outcome, "cancelled");
    assert.isAtLeast(worker.count("cancel"), 1);
    assert.strictEqual(thread.turns.length, 1);
  }).pipe(Effect.scoped, Effect.provide(peerTestLayer)),
);

it.live("cancel of an unstarted child stays cancel-pending until a terminal state", () =>
  Effect.gen(function* () {
    const worker = new FakeWorker();
    worker.cancelInterrupts = false;
    const { service } = yield* setup(worker);
    const first = yield* service.delegate(delegate("cancel-2"));
    const dispatchId = String(first.dispatchId);
    yield* waitForDispatch(dispatchId, (d) => d.childThreadId !== null);
    yield* service.cancel({ callerThreadId: CALLER_THREAD, dispatchId });
    yield* sleep(100);
    assert.strictEqual(
      (yield* service.status({ callerThreadId: CALLER_THREAD, dispatchId })).state,
      "cancel-pending",
    );
    // The child finished before the cancel landed: its real outcome wins.
    worker.finish(dispatchId, "completed", "Finished anyway.");
    const done = yield* waitForDispatch(dispatchId, (d) => d.state === "completed");
    assert.strictEqual(done.result?.summary, "Finished anyway.");
    assert.isString(done.cancelRequestedAt);
  }).pipe(Effect.scoped, Effect.provide(peerTestLayer)),
);

it.live("cancel before anything was sent is final; other threads cannot cancel", () =>
  Effect.gen(function* () {
    const worker = new FakeWorker();
    worker.partition = true;
    const { service } = yield* setup(worker);
    const first = yield* service.delegate(delegate("cancel-3"));
    const dispatchId = String(first.dispatchId);
    const foreign = yield* service.cancel({ callerThreadId: "thread-other", dispatchId });
    assert.isFalse(foreign.ok);
    // Sent but unanswered: cancel-pending; the worker never recorded it, so its reply settles it.
    const cancelled = yield* service.cancel({ callerThreadId: CALLER_THREAD, dispatchId });
    assert.strictEqual(cancelled.state, "cancel-pending");
    worker.partition = false;
    const done = yield* waitForDispatch(dispatchId, (d) => d.state === "cancelled");
    assert.isNull(done.childThreadId);
    assert.strictEqual(worker.launches, 0);
  }).pipe(Effect.scoped, Effect.provide(peerTestLayer)),
);

it.live("host-identity and authentication setup errors are typed and never retried", () =>
  Effect.gen(function* () {
    const worker = new FakeWorker();
    worker.setup = "host-identity-mismatch";
    const { service, deps } = yield* setup(worker);
    const first = yield* service.delegate(delegate("setup-1"));
    assert.isFalse(first.ok);
    assert.strictEqual(first.state, "sent-uncertain");
    assert.deepInclude(first.setupError as object, { code: "host-identity-mismatch" });
    const dispatchId = String(first.dispatchId);
    yield* sleep(100);
    // No retry loop while the setup error stands; the row is still uncertain, not failed.
    assert.strictEqual(worker.calls.length, 0);
    const row = yield* deps.dispatches.get(dispatchId);
    assert.strictEqual(row?.sendAttempts, 1);

    // The user fixes the pin (re-confirmed): kick resumes status-only probing.
    worker.setup = null;
    yield* service.kick(row!.worker.workerAuthorityId);
    yield* waitForDispatch(dispatchId, (d) => d.childThreadId !== null);
    assert.strictEqual(worker.launches, 1);
    assert.isFalse(deps.setupErrors.has(row!.worker.workerAuthorityId));

    worker.setup = "authentication-refused";
    const second = yield* service.delegate(delegate("setup-2"));
    assert.deepInclude(second.setupError as object, { code: "authentication-refused" });
  }).pipe(Effect.scoped, Effect.provide(peerTestLayer)),
);

it.live("definitive worker refusals fail the dispatch without relaunching", () =>
  Effect.gen(function* () {
    const worker = new FakeWorker();
    const thread = new FakeThread();
    yield* seedPairing();
    const refusing = {
      request: async () => ({
        _tag: "refused" as const,
        error: { code: "grant-revoked" as const, message: "revoked" },
      }),
    };
    const deps = yield* makePeerTestDeps(worker, thread, { transport: refusing });
    const service = yield* makePeerDispatchService(deps, { toolWaitMs: 500 });
    const result = yield* service.delegate(delegate("refused-1"));
    assert.strictEqual(result.state, "failed");
    assert.deepInclude(result.error as object, { code: "grant-revoked" });
    assert.strictEqual(thread.turns.length, 0);
  }).pipe(Effect.scoped, Effect.provide(peerTestLayer)),
);
