import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import migration from "../Migrations/146_ThreadOrganizationRuntime.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { makeThreadOrganizationRuntimeRepository } from "./ThreadOrganizationRuntime.ts";

import {
  policyInput,
  transitionInput,
  writeRuntimeThread,
} from "./ThreadOrganizationRuntime.test.helpers.ts";

it.effect(
  "reconciles changed settings once with independent durable rule barriers and version fencing",
  () =>
    Effect.gen(function* () {
      yield* migration;
      const repository = yield* makeThreadOrganizationRuntimeRepository;
      const first = yield* repository.reconcilePolicy(policyInput);
      assert.equal(first.status, "applied");
      assert.equal(first.policy.policyVersion, 1);
      assert.equal(first.policy.olderPolicyChangedAtMs, 1_000);
      assert.equal(first.policy.targetDrainNotBeforeMs, 301_000);
      assert.equal(first.policy.onboardingDecision, "existing-opt-in");
      assert.equal((yield* repository.reconcilePolicy(policyInput)).status, "stale");
      assert.equal(
        (yield* repository.reconcilePolicy({
          ...policyInput,
          expectedPolicyVersion: 1,
          nowMs: 2_000,
        })).status,
        "duplicate",
      );
      const second = yield* repository.reconcilePolicy({
        ...policyInput,
        expectedPolicyVersion: 1,
        policyFingerprint: "policy2",
        shortFingerprint: "short2",
        nowMs: 2_000,
      });
      assert.equal(second.policy.shortPolicyChangedAtMs, 2_000);
      assert.equal(second.policy.olderPolicyChangedAtMs, 1_000);
      assert.equal(second.policy.targetDrainNotBeforeMs, 301_000);
      const rollback = yield* repository.reconcilePolicy({
        ...policyInput,
        expectedPolicyVersion: 2,
        policyFingerprint: "policy3",
        shortFingerprint: "short3",
        olderFingerprint: "older2",
        nowMs: 10,
      });
      assert.equal(rollback.policy.policyVersion, 3);
      assert.equal(rollback.policy.shortPolicyChangedAtMs, 2_000);
      assert.equal(rollback.policy.olderPolicyChangedAtMs, 1_000);
      assert.equal(
        (yield* repository.reconcilePolicy({
          ...policyInput,
          expectedPolicyVersion: 3,
          nowMs: Number.MAX_SAFE_INTEGER,
        })).status,
        "conflict",
      );
      assert.equal((yield* repository.readPolicy()).policyVersion, 3);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("rolls policy and thread writes back atomically with their caller's transaction", () =>
  Effect.gen(function* () {
    yield* migration;
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* makeThreadOrganizationRuntimeRepository;
    const failure = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* repository.reconcilePolicy(policyInput);
          yield* writeRuntimeThread(sql, transitionInput);
          return yield* Effect.fail("rollback");
        }),
      )
      .pipe(Effect.flip);
    assert.equal(failure, "rollback");
    assert.equal((yield* repository.readPolicy()).policyVersion, 0);
    assert.equal((yield* repository.readPolicy()).canonicalFrontier, 0);
    assert.equal(yield* repository.readThread(transitionInput.threadId), undefined);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("serializes competing policy and thread mutations in one global-first lock order", () =>
  Effect.gen(function* () {
    yield* migration;
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* makeThreadOrganizationRuntimeRepository;
    const [a, b] = yield* Effect.all(
      [
        repository.reconcilePolicy(policyInput),
        repository.reconcilePolicy({ ...policyInput, policyFingerprint: "competing" }),
        sql.withTransaction(writeRuntimeThread(sql, transitionInput)),
      ],
      { concurrency: 3 },
    );
    assert.deepEqual([a.status, b.status].toSorted(), ["applied", "stale"]);
    assert.equal((yield* repository.readPolicy()).canonicalFrontier, 10);
    assert.equal((yield* repository.readPolicy()).policyVersion, 1);
    assert.equal((yield* repository.readThread(transitionInput.threadId))?.factVersion, 1);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("rejects invalid policy input without writes", () =>
  Effect.gen(function* () {
    yield* migration;
    const repository = yield* makeThreadOrganizationRuntimeRepository;
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      assert.equal(
        yield* repository.reconcilePolicy({ ...policyInput, nowMs: value }).pipe(Effect.isFailure),
        true,
      );
    assert.equal((yield* repository.readPolicy()).policyVersion, 0);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
