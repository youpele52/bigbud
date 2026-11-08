import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  "reopens durable policy/thread state after lost acknowledgement without renewing barriers",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "bigbud-organization-"))),
        (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
      );
      const filename = join(directory, "state.sqlite");
      const first = yield* Effect.gen(function* () {
        yield* migration;
        const repository = yield* makeThreadOrganizationRuntimeRepository;
        yield* repository.reconcilePolicy(policyInput);
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(writeRuntimeThread(sql, transitionInput));
        return {
          policy: yield* repository.readPolicy(),
          thread: yield* repository.readThread(transitionInput.threadId),
        };
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
      yield* Effect.gen(function* () {
        const repository = yield* makeThreadOrganizationRuntimeRepository;
        assert.deepEqual(yield* repository.readPolicy(), first.policy);
        assert.deepEqual(yield* repository.readThread(transitionInput.threadId), first.thread);
        assert.equal(
          (yield* repository.reconcilePolicy({
            ...policyInput,
            expectedPolicyVersion: 1,
            nowMs: 99_000,
          })).status,
          "duplicate",
        );
        assert.deepEqual(yield* repository.readPolicy(), first.policy);
        // Simulates settings successfully saved before DB reconciliation crashed:
        // mismatch on restart gets one persisted version and fresh independent waits.
        const changed = {
          ...policyInput,
          expectedPolicyVersion: 1,
          policyFingerprint: "saved-settings2",
          olderFingerprint: "older2",
          targetFingerprint: "enabled",
          nowMs: 99_000,
        };
        const second = yield* repository.reconcilePolicy(changed);
        assert.equal(second.policy.policyVersion, 2);
        assert.equal(second.policy.olderPolicyChangedAtMs, 99_000);
        assert.equal(second.policy.targetDrainNotBeforeMs, 399_000);
        assert.equal(
          (yield* repository.reconcilePolicy({ ...changed, expectedPolicyVersion: 2 })).status,
          "duplicate",
        );
        // A failed caller transaction leaves no partial row/frontier after reopen.
        const sql = yield* SqlClient.SqlClient;
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* writeRuntimeThread(sql, {
                ...transitionInput,
                threadId: "rolled-back",
                sourceFrontier: 20,
              });
              return yield* Effect.fail("rollback");
            }),
          )
          .pipe(Effect.flip);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
      yield* Effect.gen(function* () {
        const repository = yield* makeThreadOrganizationRuntimeRepository;
        assert.equal((yield* repository.readPolicy()).policyVersion, 2);
        assert.equal((yield* repository.readPolicy()).canonicalFrontier, 10);
        assert.equal(yield* repository.readThread("rolled-back"), undefined);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
    }).pipe(Effect.scoped),
);
