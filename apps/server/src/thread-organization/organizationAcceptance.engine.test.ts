import { CommandId, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "../orchestration/Layers/OrchestrationEngine.test.runtime.ts";
import { makeThreadOrganizationOperations } from "../persistence/Layers/ThreadOrganizationOperations.ts";
import { ServerSettingsService } from "../ws/serverSettings.ts";
import { makeOrganizationFactStore } from "./organizationFacts.store.ts";
import { makeOrganizationOwnerFacts } from "./organizationFacts.owners.ts";
import { installOrganizationOwner } from "./organizationOwner.ts";
import { organizationPolicySettings } from "./organizationPolicy.ts";
import type { ThreadOrganizationNativeOperation } from "@bigbud/contracts/orchestration/orchestration.organization.native.ts";

it(
  "canonical native acceptance commits its event and durable outcome once across lost-ACK replay",
  () =>
    withDatabase("inyosira-native-acceptance-", async (path) => {
      const runtime = createRuntime(path);
      try {
        const engine = await engineFor(runtime);
        const threadId = ThreadId.makeUnsafe("native-acceptance-thread");
        for (const command of createCommands(ProjectId.makeUnsafe("native-acceptance-project"), [
          threadId,
        ]))
          await runtime.runPromise(engine.dispatch(command));
        const operation = await runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO projection_pending_approvals (request_id, thread_id, turn_id, status, created_at, resolved_at)
          VALUES ('native-request', ${threadId}, NULL, 'pending', '2026-11-05T00:00:00.000Z', NULL)`;
            const owners = yield* makeOrganizationOwnerFacts;
            const store = makeOrganizationFactStore({ sql, owners, now: Date.now });
            const observed = yield* store.observe(threadId, 300000);
            if (!observed.row) return yield* Effect.die("missing acceptance facts");
            const settings = yield* (yield* ServerSettingsService).getSettings;
            const [installation] = yield* sql<{
              classification: "new" | "existing";
            }>`SELECT classification FROM thread_organization_installation WHERE singleton = 1`;
            const policy = {
              version: 1,
              fingerprint: organizationPolicySettings(
                settings,
                installation?.classification ?? "existing",
              ).policyFingerprint,
              scheduling: {
                idleEnabled: false,
                idleTimeoutMs: 600000,
                idleDestination: 3,
                olderEnabled: false,
                olderTimeoutMs: 86400000,
                graceMs: 300000,
              },
            };
            installOrganizationOwner(sql, {
              backendNonce: "native-test",
              generation: 1,
              active: true,
              observedAtMs: Date.now(),
              policy,
              idleNotBeforeMs: 0,
              rows: new Map([[threadId, observed.row]]),
            });
            const operation: ThreadOrganizationNativeOperation = {
              operationId: "native-acceptance",
              occurrenceId: "native-occurrence",
              attempt: 0,
              threadId,
              backendNonce: "native-test",
              generation: 1,
              policyVersion: 1,
              factVersion: observed.row.factVersion,
              expectedRevision: 0,
              from: "present",
              destination: "needs-you",
              reason: "attention",
              snoozeId: null,
              inactivityCutoffMs: null,
              createdAtMs: Date.now(),
            };
            const operations = yield* makeThreadOrganizationOperations;
            const prepared = yield* operations.prepare(operation);
            if (prepared.status !== "prepared")
              return yield* Effect.die("operation was not prepared");
            return operation;
          }),
        );
        const command = {
          type: "thread.organization.react" as const,
          commandId: CommandId.makeUnsafe(operation.operationId),
          threadId,
          state: "needs-you" as const,
          createdAt: new Date(operation.createdAtMs).toISOString(),
        };
        const first = await runtime.runPromise(
          engine.dispatch(command, { nativeOrganizationOperation: operation }),
        );
        const repeated = await runtime.runPromise(
          engine.dispatch(command, { nativeOrganizationOperation: operation }),
        );
        expect(repeated).toEqual(first);
        const persisted = await runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const operations = yield* makeThreadOrganizationOperations;
            return {
              operation: yield* operations.read(operation.operationId),
              events: yield* sql<{
                sequence: number;
              }>`SELECT sequence FROM orchestration_events WHERE command_id = ${operation.operationId}`,
              rows: yield* sql<{
                state: string;
                revision: number;
              }>`SELECT organization_state AS state, organization_revision AS revision FROM projection_threads WHERE thread_id = ${threadId}`,
            };
          }),
        );
        expect(persisted.events).toHaveLength(1);
        expect(persisted.operation?.outcome).toEqual({
          status: "applied",
          resultRevision: 1,
          resultSequence: first.sequence,
        });
        expect(persisted.rows).toEqual([{ state: "needs-you", revision: 1 }]);
        const undo = {
          type: "thread.organization.move" as const,
          commandId: CommandId.makeUnsafe("undo-while-pending"),
          threadId,
          state: "present" as const,
          expectedRevision: 1,
          undoAutomaticMoveId: operation.operationId,
          createdAt: new Date().toISOString(),
        };
        // An unresolved approval refuses restoration; replay of that refused Undo stays a no-op.
        await runtime.runPromise(engine.dispatch(undo));
        await runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`UPDATE projection_pending_approvals SET status = 'resolved', resolved_at = ${new Date().toISOString()} WHERE request_id = 'native-request'`;
          }),
        );
        await runtime.runPromise(engine.dispatch(undo));
        const state = () =>
          runtime.runPromise(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql<{
                state: string;
                revision: number;
              }>`SELECT organization_state AS state, organization_revision AS revision FROM projection_threads WHERE thread_id = ${threadId}`;
            }),
          );
        expect(await state()).toEqual([{ state: "needs-you", revision: 1 }]);
        const restored = await runtime.runPromise(
          engine.dispatch({ ...undo, commandId: CommandId.makeUnsafe("undo-after-resolution") }),
        );
        expect(await state()).toEqual([{ state: "present", revision: 2 }]);
        const protections = await runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const [row] = yield* sql<{
              grace: number;
              barrier: number;
            }>`SELECT r.grace_until_ms AS grace, g.target_drain_not_before_ms AS barrier
            FROM thread_organization_runtime_threads r CROSS JOIN thread_organization_runtime g WHERE r.thread_id = ${threadId}`;
            return row;
          }),
        );
        expect(protections!.grace).toBeGreaterThan(Date.now());
        expect(protections!.barrier).toBeGreaterThan(Date.now());
        expect(
          (
            await runtime.runPromise(
              engine.dispatch({
                ...undo,
                commandId: CommandId.makeUnsafe("undo-after-resolution"),
              }),
            )
          ).sequence,
        ).toBe(restored.sequence);
        await runtime.runPromise(
          engine.dispatch({ ...undo, commandId: CommandId.makeUnsafe("stale-undo") }),
        );
        expect(await state()).toEqual([{ state: "present", revision: 2 }]);
      } finally {
        await runtime.dispose();
      }
    }),
  30000,
);
