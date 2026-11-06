import { CommandId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { insertProjectionThreadParent } from "../persistence/Layers/ProjectionThread.test.helpers.ts";
import { makeThreadOrganizationOperations } from "../persistence/Layers/ThreadOrganizationOperations.ts";
import { ServerSettingsService } from "../ws/serverSettings.ts";
import { makeOrganizationFactStore } from "./organizationFacts.store.ts";
import { makeOrganizationAcceptance } from "./organizationAcceptance.ts";
import { installOrganizationOwner } from "./organizationOwner.ts";
import { organizationPolicySettings } from "./organizationPolicy.ts";
import type { ThreadOrganizationNativeOperation } from "@bigbud/contracts/orchestration/orchestration.organization.native.ts";

it.effect("prepared acceptance is independent of key order and fences an obsolete instance", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.makeUnsafe("acceptance-thread");
    const at = "2026-10-01T00:00:00.000Z";
    yield* insertProjectionThreadParent({ sql, threadId, createdAt: at });
    yield* sql`INSERT INTO projection_pending_approvals (request_id, thread_id, turn_id, status, created_at, resolved_at)
      VALUES ('request', ${threadId}, NULL, 'pending', ${at}, NULL)`;
    const owners = () =>
      Effect.succeed({
        terminal: { state: "unknown" as const, quietSince: null },
        shell: "unknown" as const,
      });
    const observed = yield* makeOrganizationFactStore({ sql, owners, now: Date.now }).observe(
      threadId,
      300000,
    );
    assert.isDefined(observed.row);
    const settings = yield* (yield* ServerSettingsService).getSettings;
    const policy = {
      version: 1,
      fingerprint: organizationPolicySettings(settings, "existing").policyFingerprint,
      scheduling: {
        idleEnabled: false,
        idleTimeoutMs: 600000,
        idleDestination: 3,
        olderEnabled: false,
        olderTimeoutMs: 86400000,
        graceMs: 300000,
      },
    };
    const owner = {
      backendNonce: "backend",
      generation: 1,
      active: true,
      observedAtMs: Date.now(),
      policy,
      idleNotBeforeMs: 0,
      rows: new Map([[threadId, observed.row!]]),
    };
    const uninstall = installOrganizationOwner(sql, owner);
    const operation: ThreadOrganizationNativeOperation = {
      operationId: "acceptance",
      occurrenceId: "occurrence",
      attempt: 0,
      threadId,
      backendNonce: "backend",
      generation: 1,
      policyVersion: 1,
      factVersion: observed.row!.factVersion,
      expectedRevision: 0,
      from: "present",
      destination: "needs-you",
      reason: "attention",
      snoozeId: null,
      inactivityCutoffMs: null,
      createdAtMs: Date.now(),
    };
    const operations = yield* makeThreadOrganizationOperations;
    yield* operations.prepare(operation);
    const accept = yield* makeOrganizationAcceptance;
    const reordered = Object.fromEntries(
      Object.entries(operation).toReversed(),
    ) as ThreadOrganizationNativeOperation;
    const command = {
      type: "thread.organization.react" as const,
      commandId: CommandId.makeUnsafe(operation.operationId),
      threadId,
      state: "needs-you" as const,
      createdAt: new Date(operation.createdAtMs).toISOString(),
    };
    const events = yield* sql.withTransaction(accept(command, reordered));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "thread.organization-updated");
    // Returning events alone does not claim persistence. Fence before a second acceptance:
    // no command/event/transport acknowledgement can reactivate the old owner.
    uninstall();
    const stale = yield* sql.withTransaction(accept(command, reordered));
    assert.deepEqual(stale, []);
    assert.deepEqual((yield* operations.read(operation.operationId))?.outcome, { status: "stale" });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(NodeSqliteClient.layerMemory(), ServerSettingsService.layerTest()),
    ),
  ),
);
