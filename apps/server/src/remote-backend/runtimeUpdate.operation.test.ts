import * as fs from "node:fs/promises";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach } from "vitest";
import { RemoteRuntimeUpdate } from "./Services/RemoteRuntimeUpdate.ts";
import { runtimeArchiveKeyForManifest } from "./runtimeArchive.key.ts";
import { readRuntimeArchiveEntry } from "./runtimeArchive.store.ts";
import { signedManifest } from "./runtimeArchive.test.helpers.ts";
import {
  makeGate,
  makeRuntimeUpdateHarness,
  runtimeUpdateLayer,
  uuid,
} from "./runtimeUpdate.test.helpers.ts";

const cleanup: Array<string> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});
const keyFor = (version: string) => runtimeArchiveKeyForManifest(signedManifest(version));
const request = (n: number, version = "2.0.0", interrupt = false) => ({
  requestId: uuid(n),
  version,
  source: "release" as const,
  interrupt,
});
const setup = Effect.fn("setup")(function* () {
  const harness = yield* Effect.promise(() => makeRuntimeUpdateHarness(cleanup));
  return { harness, dbPath: harness.dbPath };
});

it.effect("concurrent_requests_share_operation", () =>
  Effect.gen(function* () {
    const { harness, dbPath } = yield* setup();
    harness.gate = makeGate();
    yield* Effect.gen(function* () {
      const update = yield* RemoteRuntimeUpdate;
      const results = yield* Effect.all(
        [1, 2, 3].map((n) => update.request(request(n))),
        { concurrency: "unbounded" },
      );
      const ids = new Set(results.map((result) => result.operation.operationId));
      assert.equal(ids.size, 1);
      assert.deepStrictEqual(results.map((result) => result.disposition).toSorted(), [
        "created",
        "joined",
        "joined",
      ]);
      // A different target reconciles to the running operation instead of launching another.
      const conflict = yield* update.request(request(4, "3.0.0"));
      assert.equal(conflict.disposition, "conflict");
      assert.equal(conflict.operation.operationId, [...ids][0]);
      // Retrying the creating request replays it.
      const creator = results.find((result) => result.disposition === "created")!;
      const replay = yield* update.request(request(1));
      assert.equal(replay.operation.operationId, creator.operation.operationId);
      harness.gate!.release();
      yield* update.awaitStaging;
      const status = yield* update.status({});
      assert.equal(status.operation?.state, "staged");
      assert.deepStrictEqual(harness.resolves, ["2.0.0"]);
      const pointer = yield* Effect.promise(harness.pointer);
      assert.deepStrictEqual(pointer.pending, [keyFor("2.0.0")]);
      // The store's checkpoint asserts the single-flight lock; it is released now.
      assert.isTrue(yield* Effect.promise(harness.checkpointOutsideLockRejects));
    }).pipe(Effect.provide(runtimeUpdateLayer(harness.deps, dbPath)));
  }),
);

it.effect("staging failure releases the archive reservation", () =>
  Effect.gen(function* () {
    const { harness, dbPath } = yield* setup();
    harness.failExtract = true;
    yield* Effect.gen(function* () {
      const update = yield* RemoteRuntimeUpdate;
      const { operation } = yield* update.request(request(1));
      yield* update.awaitStaging;
      const status = yield* update.status({ operationId: operation.operationId });
      assert.equal(status.operation?.state, "failed");
      assert.match(status.operation?.failure ?? "", /Simulated extraction failure/);
      assert.deepStrictEqual((yield* Effect.promise(harness.pointer)).pending, []);
      // The slot was settled, so a new request starts a fresh operation.
      harness.failExtract = false;
      const retry = yield* update.request(request(2));
      assert.equal(retry.disposition, "created");
      assert.notEqual(retry.operation.operationId, operation.operationId);
    }).pipe(Effect.provide(runtimeUpdateLayer(harness.deps, dbPath)));
  }),
);

it.effect("restart resumes the operation state", () =>
  Effect.gen(function* () {
    const { harness, dbPath } = yield* setup();
    harness.gate = makeGate();
    // First process: staging is in flight when the backend stops.
    const operationId = yield* Effect.gen(function* () {
      const update = yield* RemoteRuntimeUpdate;
      const { operation } = yield* update.request(request(1));
      yield* Effect.promise(async () => {
        while (harness.stores.length === 0 || (await harness.pointer()).pending.length === 0)
          await new Promise((resolve) => setTimeout(resolve, 5));
      });
      assert.equal((yield* update.status({})).operation?.state, "staging");
      return operation.operationId;
    }).pipe(Effect.provide(runtimeUpdateLayer(harness.deps, dbPath)));
    // Second process: the same durable operation resumes staging and reaches staged.
    harness.gate = undefined;
    yield* Effect.gen(function* () {
      const update = yield* RemoteRuntimeUpdate;
      yield* update.awaitStaging;
      const status = yield* update.status({});
      assert.equal(status.operation?.operationId, operationId);
      assert.equal(status.operation?.state, "staged");
      const store = harness.stores.at(-1)!;
      assert.isNotNull(
        yield* Effect.promise(() => readRuntimeArchiveEntry(store, keyFor("2.0.0"))),
      );
    }).pipe(Effect.provide(runtimeUpdateLayer(harness.deps, dbPath)));
    // Third process: a staged operation stays staged (WP-4D owns what follows).
    yield* Effect.gen(function* () {
      const update = yield* RemoteRuntimeUpdate;
      assert.equal((yield* update.status({})).operation?.state, "staged");
      assert.deepStrictEqual(harness.resolves, ["2.0.0", "2.0.0"]);
    }).pipe(Effect.provide(runtimeUpdateLayer(harness.deps, dbPath)));
  }),
);

it.effect("cancel settles the operation and releases a staged reservation", () =>
  Effect.gen(function* () {
    const { harness, dbPath } = yield* setup();
    yield* Effect.gen(function* () {
      const update = yield* RemoteRuntimeUpdate;
      const { operation } = yield* update.request(request(1));
      yield* update.awaitStaging;
      const cancelled = yield* update.cancel({ operationId: operation.operationId });
      assert.equal(cancelled.state, "cancelled");
      assert.deepStrictEqual((yield* Effect.promise(harness.pointer)).pending, []);
      // Settled operations are not resurrected, and activating ones cannot be cancelled.
      const again = yield* update.cancel({ operationId: operation.operationId });
      assert.equal(again.state, "cancelled");
      const advanced = yield* Effect.flip(update.advance(operation.operationId, "awaiting-drain"));
      assert.equal(advanced.code, "invalid-state");
    }).pipe(Effect.provide(runtimeUpdateLayer(harness.deps, dbPath)));
  }),
);

it.effect("advance follows the state machine and keeps activation for WP-4D", () =>
  Effect.gen(function* () {
    const { harness, dbPath } = yield* setup();
    yield* Effect.gen(function* () {
      const update = yield* RemoteRuntimeUpdate;
      const { operation } = yield* update.request(request(1));
      yield* update.awaitStaging;
      const id = operation.operationId;
      assert.equal((yield* Effect.flip(update.advance(id, "activated"))).code, "invalid-state");
      assert.equal((yield* update.advance(id, "awaiting-drain")).state, "awaiting-drain");
      assert.equal((yield* update.advance(id, "deferred")).state, "deferred");
      assert.equal((yield* update.advance(id, "awaiting-drain")).state, "awaiting-drain");
      const key = yield* update.withSingleFlight(
        (_store, archiveKey) => Effect.succeed(archiveKey),
        id,
      );
      assert.equal(key, keyFor("2.0.0"));
      assert.equal((yield* update.advance(id, "activating")).state, "activating");
      assert.equal((yield* Effect.flip(update.cancel({ operationId: id }))).code, "invalid-state");
    }).pipe(Effect.provide(runtimeUpdateLayer(harness.deps, dbPath)));
  }),
);

it.effect("a known downgrade is refused at request time, before anything is staged", () =>
  Effect.gen(function* () {
    const { harness, dbPath } = yield* setup();
    yield* Effect.gen(function* () {
      const update = yield* RemoteRuntimeUpdate;
      const refused = yield* update.request(request(1, "2.0.0")).pipe(Effect.flip);
      assert.equal(refused.code, "invalid-state");
      assert.match(refused.message, /Downgrading from 2\.1\.0 to 2\.0\.0 is refused/);
      assert.isNull((yield* update.status({})).operation);
      assert.deepStrictEqual(harness.resolves, []);
    }).pipe(
      Effect.provide(runtimeUpdateLayer({ ...harness.deps, runningVersion: "2.1.0" }, dbPath)),
    );
  }),
);
