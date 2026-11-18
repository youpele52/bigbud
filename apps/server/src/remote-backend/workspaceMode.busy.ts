/**
 * Is a workspace idle in THIS backend? Running sessions, turn admissions, activity/worktree leases
 * and open terminals for any thread of a project bound to the folder count as busy.
 *
 * @module workspaceMode.busy
 */
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { OrchestrationReadModel } from "@bigbud/contracts";

import type { TerminalManagerShape } from "../terminal/Services/Manager.ts";

export const findWorkspaceBusyReason = Effect.fn("findWorkspaceBusyReason")(function* (input: {
  readonly sql: SqlClient.SqlClient;
  readonly terminal: TerminalManagerShape | undefined;
  readonly readModel: OrchestrationReadModel;
  readonly projectIds: ReadonlySet<string>;
}) {
  for (const thread of input.readModel.threads) {
    if (!input.projectIds.has(thread.projectId)) continue;
    if (thread.session?.status === "running") return `thread '${thread.id}' has a running turn.`;
    const leases =
      yield* input.sql`SELECT 1 FROM worktree_runtime_leases WHERE thread_id = ${thread.id}
      UNION ALL SELECT 1 FROM thread_activity_leases WHERE thread_id = ${thread.id}
      UNION ALL SELECT 1 FROM provider_turn_admissions
        WHERE owner_thread_id = ${thread.id} AND state <> 'terminal' LIMIT 1`.pipe(
        Effect.orElseSucceed(() => [{ unknown: true }]),
      );
    if (leases.length) return `thread '${thread.id}' has running or admitted work.`;
    if (input.terminal?.hasActiveThread && (yield* input.terminal.hasActiveThread(thread.id)))
      return `thread '${thread.id}' has an open terminal.`;
  }
  return undefined;
});
