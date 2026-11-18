/**
 * Live drain probe over the orchestration read model and durable leases (M3 WP-4D).
 *
 * Affected work: active or starting turns and pending turn starts, pending approvals and
 * user-input requests (read model), plus durable activity leases, shell worktree leases and
 * non-terminal provider turn admissions (SQL; a read error counts as busy). Excluded:
 * - terminal leases: remote terminals are owned by the independent Rust unit and survive;
 * - provider leases: they follow a live (or, after a crash, stale) provider SESSION, not work.
 *   A running turn is already a `turn` item (read model) and a non-terminal admission; an idle
 *   session ends with the restart and resumes from its kept cursor.
 */
import { randomUUID } from "node:crypto";
import { CommandId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { RemoteRuntimeUpdateAffectedWork } from "@bigbud/contracts/server/remoteBackendUpdate.ts";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { hasPendingTurnStart } from "../orchestration/PendingTurnStart.logic.ts";
import { hasActiveThreadTurnOrSession } from "../orchestration/ThreadDispatchSafety.logic.ts";
import { resolveThreadWorkflowStatus } from "../orchestration/ThreadWorkflowStatus.logic.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { RuntimeUpdateDrainProbe } from "./runtimeUpdate.drain.ts";

const label = (text: string, fallback: string) => (text.trim() || fallback).slice(0, 256);

export function makeRuntimeUpdateDrainProbe(input: {
  readonly engine: OrchestrationEngineShape;
  readonly sql: SqlClient.SqlClient;
}): RuntimeUpdateDrainProbe {
  const { engine, sql } = input;
  const affectedWork = Effect.gen(function* () {
    const model = yield* engine.getReadModel();
    const items: Array<RemoteRuntimeUpdateAffectedWork> = [];
    const titles = new Map<string, string>();
    for (const thread of model.threads) {
      if (thread.deletedAt != null) continue;
      const name = label(thread.title, thread.id);
      titles.set(thread.id, name);
      if (hasActiveThreadTurnOrSession(thread) || hasPendingTurnStart(thread))
        items.push({ kind: "turn", id: `${thread.id}#turn`, label: name });
      const workflow = resolveThreadWorkflowStatus(thread);
      if (workflow.hasPendingApprovals)
        items.push({ kind: "approval", id: `${thread.id}#approval`, label: name });
      if (workflow.hasPendingUserInput)
        items.push({ kind: "user-input", id: `${thread.id}#user-input`, label: name });
    }
    const rows = yield* sql<{ readonly threadId: string; readonly kind: string }>`
      SELECT thread_id AS "threadId", 'activity' AS kind FROM thread_activity_leases
      UNION ALL SELECT thread_id, runtime_kind FROM worktree_runtime_leases
        WHERE runtime_kind NOT IN ('terminal', 'provider')
      UNION ALL SELECT owner_thread_id, 'admission' FROM provider_turn_admissions
        WHERE state <> 'terminal'`.pipe(
      Effect.orElseSucceed(() => [{ threadId: "unknown", kind: "unreadable" }]),
    );
    for (const row of rows) {
      const id = `${row.threadId}#${row.kind}`;
      if (items.some((item) => item.id === id)) continue;
      items.push({ kind: "other", id, label: titles.get(row.threadId) ?? label("", id) });
    }
    return items;
  });
  return {
    affectedWork,
    settleCommands: engine.withWorkspaceBarrier
      ? engine.withWorkspaceBarrier(Effect.void)
      : Effect.void,
    interruptThread: (threadId) =>
      engine
        .dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe(`server:runtime-update:${randomUUID()}:${threadId}`),
          threadId: ThreadId.makeUnsafe(threadId),
          createdAt: new Date().toISOString(),
        })
        .pipe(
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Effect.logWarning("Runtime update could not interrupt a turn", { threadId, cause }),
          ),
        ),
  };
}
