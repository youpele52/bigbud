import { CommandId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { insertProjectionThreadParent } from "../../persistence/Layers/ProjectionThread.test.helpers.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { makeTerminalIdleGuard } from "./OrchestrationEngine.terminalIdle.ts";

it.effect(
  "final acceptance rechecks exact age, pending attention and revision after sweep selection",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const threadId = ThreadId.makeUnsafe("guard-thread");
      const old = "2026-10-01T00:00:00.000Z";
      yield* insertProjectionThreadParent({ sql, threadId, createdAt: old });
      yield* sql`UPDATE projection_threads SET last_activity_at = ${old} WHERE thread_id = ${threadId}`;
      const guard = yield* makeTerminalIdleGuard();
      const command = {
        type: "thread.organization.idle" as const,
        commandId: CommandId.makeUnsafe("guard"),
        threadId,
        fromState: "present" as const,
        expectedRevision: 0,
        destination: "later" as const,
        terminalIdleCutoff: "2026-10-15T00:00:00.000Z",
        createdAt: "2026-11-05T00:00:00.000Z",
      };
      assert.isFalse(yield* guard(command));
      yield* sql`UPDATE projection_threads SET organization_revision = 1,
    organization_age_provenance = 'pending', organization_changed_at = ${old} WHERE thread_id = ${threadId}`;
      assert.isTrue(yield* guard({ ...command, expectedRevision: 1 }));
      yield* sql`UPDATE projection_threads SET organization_revision = 0 WHERE thread_id = ${threadId}`;
      yield* sql`INSERT INTO projection_pending_approvals (request_id, thread_id, turn_id, status,
    created_at, resolved_at) VALUES ('request', ${threadId}, NULL, 'pending', ${old}, NULL)`;
      assert.isTrue(yield* guard(command));
      yield* sql`DELETE FROM projection_pending_approvals WHERE request_id = 'request'`;
      yield* sql`UPDATE projection_threads SET organization_revision = 1,
    organization_age_provenance = 'known', organization_activity_at = ${old} WHERE thread_id = ${threadId}`;
      assert.isTrue(yield* guard(command));
      assert.isFalse(yield* guard({ ...command, expectedRevision: 1 }));
      yield* sql`UPDATE projection_threads SET organization_activity_at = '2026-11-01T00:00:00.000Z' WHERE thread_id = ${threadId}`;
      assert.isTrue(yield* guard({ ...command, expectedRevision: 1 }));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(ServerSettingsService.layerTest(), NodeSqliteClient.layerMemory()),
      ),
    ),
);
