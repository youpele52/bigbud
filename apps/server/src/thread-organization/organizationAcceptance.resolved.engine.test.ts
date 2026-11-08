import { CommandId, EventId, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { ThreadOrganizationNativeOperation } from "@bigbud/contracts/orchestration/orchestration.organization.native.ts";
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
import type { OrganizationRow } from "./organizationProtocol.ts";

type Runtime = ReturnType<typeof createRuntime>;
const threadId = ThreadId.makeUnsafe("resolved-thread");

const activity = (kind: string, id: string) => ({
  type: "thread.activity.append" as const,
  commandId: CommandId.makeUnsafe(`activity-${id}`),
  threadId,
  activity: {
    id: EventId.makeUnsafe(`event-${id}`),
    kind,
    turnId: null,
    tone: "info" as const,
    summary: kind,
    createdAt: new Date().toISOString(),
    payload: { requestId: "resolved-request", requestKind: "command" },
  },
  createdAt: new Date().toISOString(),
});

/** Observe current facts, install a live owner holding them and prepare one native operation. */
const prepare = (
  runtime: Runtime,
  reason: ThreadOrganizationNativeOperation["reason"],
  from: ThreadOrganizationNativeOperation["from"],
  destination: ThreadOrganizationNativeOperation["destination"],
  revision: number,
) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const owners = yield* makeOrganizationOwnerFacts;
      const observed = yield* makeOrganizationFactStore({ sql, owners, now: Date.now }).observe(
        threadId,
        300000,
      );
      if (!observed.row) return yield* Effect.die("missing facts");
      const settings = yield* (yield* ServerSettingsService).getSettings;
      const [installation] = yield* sql<{
        classification: "new" | "existing";
      }>`SELECT classification FROM thread_organization_installation WHERE singleton = 1`;
      const classification = installation?.classification ?? "existing";
      installOrganizationOwner(sql, {
        backendNonce: "resolved-test",
        generation: 1,
        active: true,
        observedAtMs: Date.now(),
        policy: {
          version: 1,
          fingerprint: organizationPolicySettings(settings, classification).policyFingerprint,
          scheduling: {
            idleEnabled: false,
            idleTimeoutMs: 600000,
            idleDestination: 3,
            olderEnabled: false,
            olderTimeoutMs: 86400000,
            graceMs: 300000,
          },
        },
        idleNotBeforeMs: 0,
        rows: new Map<string, OrganizationRow>([[threadId, observed.row]]),
      });
      const operation: ThreadOrganizationNativeOperation = {
        operationId: `op-${reason}-${revision}`,
        occurrenceId: `occurrence-${reason}-${revision}`,
        attempt: 0,
        threadId,
        backendNonce: "resolved-test",
        generation: 1,
        policyVersion: 1,
        factVersion: observed.row.factVersion,
        expectedRevision: revision,
        from,
        destination,
        reason,
        snoozeId: null,
        inactivityCutoffMs: null,
        createdAtMs: Date.now(),
      };
      const prepared = yield* (yield* makeThreadOrganizationOperations).prepare(operation);
      if (prepared.status !== "prepared") return yield* Effect.die("not prepared");
      return { operation, row: observed.row };
    }),
  );

const react = (runtime: Runtime, operation: ThreadOrganizationNativeOperation) =>
  engineFor(runtime).then((engine) =>
    runtime.runPromise(
      engine.dispatch(
        {
          type: "thread.organization.react",
          commandId: CommandId.makeUnsafe(operation.operationId),
          threadId,
          state: operation.destination,
          createdAt: new Date(operation.createdAtMs).toISOString(),
        },
        { nativeOrganizationOperation: operation },
      ),
    ),
  );

const read = (runtime: Runtime) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<{
        state: string;
        revision: number;
        grace: number | null;
      }>`SELECT t.organization_state AS state, t.organization_revision AS revision, r.grace_until_ms AS grace
        FROM projection_threads t LEFT JOIN thread_organization_runtime_threads r ON r.thread_id = t.thread_id
        WHERE t.thread_id = ${threadId}`;
      return row!;
    }),
  );

it(
  "an answered automatic Needs you placement returns to Present with grace and can be undone",
  () =>
    withDatabase("inyosira-resolved-", async (path) => {
      const runtime = createRuntime(path);
      try {
        const engine = await engineFor(runtime);
        for (const command of createCommands(ProjectId.makeUnsafe("resolved-project"), [threadId]))
          await runtime.runPromise(engine.dispatch(command));
        await runtime.runPromise(engine.dispatch(activity("approval.requested", "requested")));
        const attention = await prepare(runtime, "attention", "present", "needs-you", 0);
        await react(runtime, attention.operation);
        expect(await read(runtime)).toMatchObject({ state: "needs-you", revision: 1 });
        // The answer is request activity, not a deliberate move: automatic placement survives.
        await runtime.runPromise(engine.dispatch(activity("approval.resolved", "resolved")));
        const resolved = await prepare(runtime, "resolved", "needs-you", "present", 1);
        expect(resolved.row).toMatchObject({
          section: 1,
          actionable: false,
          automaticPlacement: true,
        });
        await react(runtime, resolved.operation);
        const after = await read(runtime);
        expect(after).toMatchObject({ state: "present", revision: 2 });
        expect(after.grace).toBeGreaterThan(Date.now() + 200000);
        const events = await runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql<{
              payload: string;
            }>`SELECT payload_json AS payload FROM orchestration_events WHERE command_id = ${resolved.operation.operationId}`;
          }),
        );
        expect(events).toHaveLength(1);
        expect(JSON.parse(events[0]!.payload)).toMatchObject({
          reason: "move",
          source: "automatic",
          automaticMove: { reason: "resolved", from: "needs-you" },
        });
        await runtime.runPromise(
          engine.dispatch({
            type: "thread.organization.move",
            commandId: CommandId.makeUnsafe("undo-resolved"),
            threadId,
            state: "needs-you",
            expectedRevision: 2,
            undoAutomaticMoveId: resolved.operation.operationId,
            createdAt: new Date().toISOString(),
          }),
        );
        expect(await read(runtime)).toMatchObject({ state: "needs-you", revision: 3 });
        // Undo is deliberate: the restored placement is manual and never auto-returns.
        const manual = await prepare(runtime, "resolved", "needs-you", "present", 3);
        expect(manual.row.automaticPlacement).toBe(false);
        await react(runtime, manual.operation);
        expect(await read(runtime)).toMatchObject({ state: "needs-you", revision: 3 });
      } finally {
        await runtime.dispose();
      }
    }),
  30000,
);
