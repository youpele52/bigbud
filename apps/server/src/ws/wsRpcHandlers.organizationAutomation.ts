import * as Effect from "effect/Effect";
import {
  OrganizationAutomationError,
  ORGANIZATION_AUTOMATION_METHODS,
  type OrganizationEngagementInput,
} from "@bigbud/contracts/server/organizationAutomation.ts";
import { organizationStatus } from "../thread-organization/organizationStatus.ts";
import { updateOrganizationEngagement } from "../thread-organization/organizationEngagement.ts";
import { organizationOwner } from "../thread-organization/organizationOwner.ts";
import { sshMonitorCallerId } from "../ssh/sshMonitor.connections.ts";
import type { WsRpcContext } from "./wsRpcContext.ts";
export function makeOrganizationAutomationHandlers(context: WsRpcContext) {
  return {
    [ORGANIZATION_AUTOMATION_METHODS.status]: () =>
      Effect.gen(function* () {
        const sql = context.worktreeSql;
        if (!sql) return yield* Effect.fail("Organisation persistence unavailable");
        const [installation] = yield* sql<{
          classification: "new" | "existing";
        }>`SELECT classification FROM thread_organization_installation WHERE singleton = 1`;
        return {
          ...organizationStatus(sql),
          installation: installation?.classification ?? "existing",
        };
      }).pipe(
        Effect.mapError(
          () => new OrganizationAutomationError({ message: "Organisation status unavailable" }),
        ),
      ),
    [ORGANIZATION_AUTOMATION_METHODS.engagement]: (
      input: OrganizationEngagementInput,
      options?: { clientId: number },
    ) =>
      Effect.gen(function* () {
        const sql = context.worktreeSql;
        const caller = sshMonitorCallerId(context.monitorInstanceId, options?.clientId);
        if (!sql || !caller) return yield* Effect.fail("Organisation caller unavailable");
        const [thread] =
          yield* sql`SELECT 1 FROM projection_threads WHERE thread_id = ${input.threadId} AND purpose = 'standard' AND archived_at IS NULL AND deleting_at IS NULL AND deleted_at IS NULL`;
        if (!thread) return false;
        const accepted = updateOrganizationEngagement(sql, caller, input.threadId, input.engaged);
        // Publish the lease promptly instead of waiting for the 15s sweep. Never schedules.
        if (accepted) organizationOwner(sql)?.observe?.([input.threadId]);
        return accepted;
      }).pipe(
        Effect.mapError(
          () => new OrganizationAutomationError({ message: "Organisation engagement unavailable" }),
        ),
      ),
  };
}
