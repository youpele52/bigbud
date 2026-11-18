import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

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
import { makePeerToolWaits } from "./peerDispatch.toolWait.ts";

const delegateInput = (invocationId: string) => ({
  callerThreadId: CALLER_THREAD,
  invocationId,
  task: "Summarize the logs.",
});

const waitFor = (done: () => boolean, timeoutMs = 3_000) =>
  Effect.promise(async () => {
    const deadline = Date.now() + timeoutMs;
    while (!done()) {
      if (Date.now() > deadline) throw new Error("condition never held");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });

it("hands a refusal to a waiting tool call, otherwise to the follower", () => {
  const waits = makePeerToolWaits();
  const error = { code: "grant-revoked", message: "revoked" } as const;
  assert.isFalse(waits.handOff("d1", error));
  waits.enter("d1");
  assert.isTrue(waits.handOff("d1", error));
  assert.deepStrictEqual(waits.leave("d1"), error);
  // The tool stopped waiting first: the follower delivers.
  waits.enter("d2");
  assert.isUndefined(waits.leave("d2"));
  assert.isFalse(waits.handOff("d2", error));
});

it.live("a refusal after the tool returned sent-uncertain delivers one failure", () =>
  Effect.gen(function* () {
    yield* seedPairing();
    const worker = new FakeWorker();
    const thread = new FakeThread();
    const deps = yield* makePeerTestDeps(worker, thread);
    const service = yield* makePeerDispatchService(deps, { toolWaitMs: 100 });
    worker.partition = true;
    const first = yield* service.delegate(delegateInput("rejected-late"));
    assert.strictEqual(first.state, "sent-uncertain");
    const dispatchId = String(first.dispatchId);

    // The re-send reaches the worker, which refuses it before accepting.
    worker.refuseDelegate = "grant-revoked";
    worker.partition = false;
    const failed = yield* waitForDispatch(dispatchId, (d) => d.state === "failed");
    assert.strictEqual(failed.error?.code, "grant-revoked");
    assert.strictEqual(worker.launches, 0);
    assert.deepStrictEqual(
      thread.turns.map((turn) => turn.commandId),
      [peerResultCommandId(dispatchId)],
    );
    assert.match(thread.turns[0]!.text, /failed/);
    assert.match(thread.turns[0]!.text, /refused this task before accepting it \(grant-revoked\)/);
    yield* Effect.sleep("100 millis");
    assert.strictEqual(thread.calls.length, 1);
  }).pipe(Effect.scoped, Effect.provide(peerTestLayer)),
);

it.live("a refusal the tool returned directly is not also delivered", () =>
  Effect.gen(function* () {
    yield* seedPairing();
    const worker = new FakeWorker();
    worker.refuseDelegate = "permission-exceeds-ceiling";
    const thread = new FakeThread();
    const deps = yield* makePeerTestDeps(worker, thread);
    const service = yield* makePeerDispatchService(deps, { toolWaitMs: 2_000 });
    const result = yield* service.delegate(delegateInput("rejected-sync"));
    assert.isFalse(result.ok);
    assert.strictEqual(result.state, "failed");
    assert.deepInclude(result.error as object, { code: "permission-exceeds-ceiling" });
    yield* waitForDispatch(String(result.dispatchId), (d) => d.state === "failed");
    yield* Effect.sleep("100 millis");
    assert.strictEqual(thread.calls.length, 0);
  }).pipe(Effect.scoped, Effect.provide(peerTestLayer)),
);

it.live("a restart between delivery and settlement re-delivers under the same identity", () =>
  Effect.gen(function* () {
    yield* seedPairing();
    const worker = new FakeWorker();
    const thread = new FakeThread();
    let dispatchId = "";
    // First backend: the delivery hangs and the backend stops before the row settles.
    yield* Effect.gen(function* () {
      const deps = yield* makePeerTestDeps(worker, thread);
      const service = yield* makePeerDispatchService(deps, { toolWaitMs: 100 });
      worker.partition = true;
      const first = yield* service.delegate(delegateInput("rejected-replay"));
      dispatchId = String(first.dispatchId);
      thread.hang = true;
      worker.refuseDelegate = "grant-revoked";
      worker.partition = false;
      yield* waitFor(() => thread.calls.length === 1);
    }).pipe(Effect.scoped);
    yield* waitForDispatch(dispatchId, (d) => d.state === "sent-uncertain");

    // Second backend resumes the unsettled row: same delivery id, still one turn.
    thread.hang = false;
    const deps = yield* makePeerTestDeps(worker, thread);
    const service = yield* makePeerDispatchService(deps, { toolWaitMs: 100 });
    assert.strictEqual(yield* service.resume(), 1);
    yield* waitForDispatch(dispatchId, (d) => d.state === "failed");
    assert.strictEqual(thread.calls.length, 2);
    assert.deepStrictEqual(
      thread.calls.map((call) => call.commandId),
      [peerResultCommandId(dispatchId), peerResultCommandId(dispatchId)],
    );
    assert.strictEqual(thread.turns.length, 1);
  }).pipe(Effect.scoped, Effect.provide(peerTestLayer)),
);
