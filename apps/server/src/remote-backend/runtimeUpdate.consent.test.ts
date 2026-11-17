import * as fs from "node:fs/promises";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach } from "vitest";
import { RemoteRuntimeUpdate } from "./Services/RemoteRuntimeUpdate.ts";
import { runtimeUpdateAffectedWorkDigest } from "./runtimeUpdate.consent.ts";
import {
  makeRuntimeUpdateHarness,
  runtimeUpdateLayer,
  uuid,
} from "./runtimeUpdate.test.helpers.ts";

const cleanup: Array<string> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});
const turn = { kind: "turn" as const, id: "thread-1:turn-7", label: "Refactor parser" };
const approval = { kind: "approval" as const, id: "approval-3", label: "Run migrations" };

const staged = Effect.fn("staged")(function* (interrupt: boolean) {
  const update = yield* RemoteRuntimeUpdate;
  const { operation } = yield* update.request({
    requestId: uuid(1),
    version: "2.0.0",
    source: "release",
    interrupt,
  });
  yield* update.awaitStaging;
  return { update, operationId: operation.operationId };
});

it("binds the affected-work digest to the operation and is order independent", () => {
  const a = runtimeUpdateAffectedWorkDigest(uuid(1), [turn, approval]);
  assert.equal(a, runtimeUpdateAffectedWorkDigest(uuid(1), [approval, turn]));
  assert.notEqual(a, runtimeUpdateAffectedWorkDigest(uuid(2), [turn, approval]));
  assert.notEqual(a, runtimeUpdateAffectedWorkDigest(uuid(1), [turn]));
});

it.effect("setup_authority_alone_is_not_interruption_consent", () =>
  Effect.gen(function* () {
    const harness = yield* Effect.promise(() => makeRuntimeUpdateHarness(cleanup));
    harness.work.push(turn);
    yield* Effect.gen(function* () {
      // An authorized request that asks for interruption records the wish, never consent.
      const { update, operationId } = yield* staged(true);
      const status = yield* update.status({});
      assert.equal(status.operation?.interruptRequested, true);
      assert.equal(status.operation?.consent, "none");
      assert.deepStrictEqual(status.affectedWork, [turn]);
      const denied = yield* Effect.flip(update.consumeInterruptionConsent(operationId));
      assert.equal(denied.code, "consent-required");
    }).pipe(Effect.provide(runtimeUpdateLayer(harness.deps, harness.dbPath)));
  }),
);

it.effect("consent requires an interrupting update request", () =>
  Effect.gen(function* () {
    const harness = yield* Effect.promise(() => makeRuntimeUpdateHarness(cleanup));
    harness.work.push(turn);
    yield* Effect.gen(function* () {
      const { update, operationId } = yield* staged(false);
      const { affectedWorkDigest } = yield* update.status({});
      const denied = yield* Effect.flip(
        update.consent({ operationId, affectedWorkDigest: affectedWorkDigest! }),
      );
      assert.equal(denied.code, "invalid-state");
    }).pipe(Effect.provide(runtimeUpdateLayer(harness.deps, harness.dbPath)));
  }),
);

it.effect("stale_or_reused_consent_rejected", () =>
  Effect.gen(function* () {
    const harness = yield* Effect.promise(() => makeRuntimeUpdateHarness(cleanup));
    harness.work.push(turn);
    yield* Effect.gen(function* () {
      const { update, operationId } = yield* staged(true);
      const first = (yield* update.status({})).affectedWorkDigest!;
      // A digest for another operation, or for a different list, is stale.
      const otherOperation = runtimeUpdateAffectedWorkDigest(uuid(9), [turn]);
      const wrong = yield* Effect.flip(
        update.consent({ operationId, affectedWorkDigest: otherOperation }),
      );
      assert.equal(wrong.code, "consent-stale");
      assert.equal(
        (yield* update.consent({ operationId, affectedWorkDigest: first })).consent,
        "recorded",
      );
      // Repeating the same consent is idempotent before use.
      assert.equal(
        (yield* update.consent({ operationId, affectedWorkDigest: first })).consent,
        "recorded",
      );

      // The affected work changed after consent: consumption refuses the old consent.
      harness.work.push(approval);
      const changed = yield* Effect.flip(update.consumeInterruptionConsent(operationId));
      assert.equal(changed.code, "consent-stale");
      const old = yield* Effect.flip(update.consent({ operationId, affectedWorkDigest: first }));
      assert.equal(old.code, "consent-stale");

      const second = (yield* update.status({})).affectedWorkDigest!;
      yield* update.consent({ operationId, affectedWorkDigest: second });
      assert.equal((yield* update.consumeInterruptionConsent(operationId)).consent, "consumed");
      // Single use: neither a second consumption nor re-supplying consent is accepted.
      const reused = yield* Effect.flip(update.consumeInterruptionConsent(operationId));
      assert.equal(reused.code, "consent-reused");
      const resupplied = yield* Effect.flip(
        update.consent({ operationId, affectedWorkDigest: second }),
      );
      assert.equal(resupplied.code, "consent-reused");

      // Consent for a settled operation is stale.
      yield* update.cancel({ operationId });
      const settled = yield* Effect.flip(
        update.consent({ operationId, affectedWorkDigest: second }),
      );
      assert.equal(settled.code, "consent-stale");
    }).pipe(Effect.provide(runtimeUpdateLayer(harness.deps, harness.dbPath)));
  }),
);
