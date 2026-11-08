import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ServerSettings } from "@bigbud/contracts/core/settings.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { makeThreadOrganizationOperations } from "../persistence/Layers/ThreadOrganizationOperations.ts";
import type { makeThreadOrganizationRuntimeRepository } from "../persistence/Layers/ThreadOrganizationRuntime.ts";
import { dispatchOrganizationOperation } from "./organizationBridge.proposals.ts";
import { OrganizationResync } from "./organizationLifecycle.ts";
import { organizationPolicySettings, organizationWirePolicy } from "./organizationPolicy.ts";

type Runtime = Effect.Success<typeof makeThreadOrganizationRuntimeRepository>;
type Operations = Effect.Success<typeof makeThreadOrganizationOperations>;

export const readOrganizationInstallation = (sql: SqlClient.SqlClient) =>
  sql<{
    classification: "new" | "existing";
  }>`SELECT classification FROM thread_organization_installation WHERE singleton = 1`.pipe(
    Effect.map(([row]) => row?.classification ?? ("existing" as const)),
  );

/** Persist the current settings' policy identity/barriers before anything is published. */
export const reconcileOrganizationPolicy = Effect.fn("OrganizationBridge.reconcilePolicy")(
  function* (
    runtime: Runtime,
    settings: ServerSettings,
    classification: "new" | "existing",
    nowMs: number,
  ) {
    const current = yield* runtime.readPolicy();
    const reconciled = yield* runtime.reconcilePolicy({
      ...organizationPolicySettings(settings, classification),
      expectedPolicyVersion: current.policyVersion,
      initialize: current.policyVersion === 0,
      nowMs,
      graceMs: settings.inyosiraGraceMinutes * 60000,
    });
    // A concurrent reconcile is routine (settings saved twice); the next attempt re-reads.
    if (reconciled.status === "stale" || reconciled.status === "conflict")
      return yield* Effect.fail(new OrganizationResync("organisation policy changed concurrently"));
    return {
      stored: reconciled.policy,
      wire: organizationWirePolicy(settings, classification, reconciled.policy),
    };
  },
);

/** Unknown previous prepared outcomes are resolved only against durable receipts, never
 * replayed under a replacement native identity. Acceptance is serialized with all commands.
 */
export const recoverOrganizationOperations = Effect.fn("OrganizationBridge.recover")(function* (
  engine: OrchestrationEngineShape,
  operations: Operations,
) {
  for (const pending of yield* operations.pending()) {
    yield* dispatchOrganizationOperation(engine, operations, pending.operation);
    const settled = yield* operations.read(pending.operation.operationId);
    if (!settled?.outcome)
      return yield* Effect.fail(new Error("organisation recovery outcome remains unknown"));
  }
});
