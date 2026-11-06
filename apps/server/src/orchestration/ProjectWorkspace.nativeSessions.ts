import {
  CommandId,
  type ThreadId,
  type ProviderKind,
  type ProviderSession,
} from "@bigbud/contracts";
import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../provider/Errors.ts";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ProviderAdapterRegistryShape } from "../provider/Services/ProviderAdapterRegistry.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

export const MUSE_WORKSPACE_RESET_NOTICE =
  "Muse native context was archived for this folder change. Bigbud history is unchanged. On next use, Muse starts a fresh native session with your explicit current provider/model selection; the original native session remains a recovery copy.";

/** Stop each adapter independently, including dormant provider handles for a differently selected thread. */
export function prepareIdleProjectWorkspaceSessions(
  sql: SqlClient.SqlClient,
  registry: ProviderAdapterRegistryShape,
  engine: OrchestrationEngineShape,
  projectId: string,
) {
  const fail = (detail: string) =>
    new OrchestrationCommandInvariantError({ commandType: "project.reconfigure", detail });
  return Effect.gen(function* () {
    const rows = yield* sql<{
      threadId: ThreadId;
    }>`SELECT thread_id AS "threadId" FROM projection_threads WHERE project_id = ${projectId}`;
    const ids = new Set(rows.map((row) => row.threadId));
    if (engine.ensureThreadState)
      for (const row of rows) yield* engine.ensureThreadState(row.threadId, "history");
    const adapters: Array<{
      provider: ProviderKind;
      adapter: ProviderAdapterShape<ProviderAdapterError>;
      sessions: ReadonlyArray<ProviderSession>;
    }> = [];
    for (const provider of yield* registry.listProviders()) {
      const adapter = yield* registry.getByProvider(provider);
      const sessions = (yield* adapter.listSessions()).filter((session) =>
        ids.has(session.threadId),
      );
      if (
        sessions.some(
          (session) =>
            session.activeTurnId || !["ready", "stopped", "error"].includes(session.status),
        )
      )
        return yield* fail(
          "Stop all provider turns before changing this project folder. No native handles were closed.",
        );
      adapters.push({ provider, adapter, sessions });
    }
    const busy =
      yield* sql`SELECT 1 FROM worktree_runtime_leases WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = ${projectId})
      UNION ALL SELECT 1 FROM thread_activity_leases WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = ${projectId})
      UNION ALL SELECT 1 FROM projection_turns WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = ${projectId}) AND state IN ('pending','running') LIMIT 1`;
    if (busy.length)
      return yield* fail(
        "Close terminals and settle active work before changing the project folder.",
      );
    return {
      idleOwners: adapters.flatMap(({ provider, sessions }) =>
        sessions
          .filter((session) => session.status === "ready")
          .map((session) => ({ threadId: session.threadId, provider })),
      ),
      stop: Effect.gen(function* () {
        for (const { provider, adapter, sessions } of adapters) {
          for (const session of sessions) {
            yield* adapter.stopSession(session.threadId);
            // Only a positively observed stopped owner can settle its app-owned runtime row.
            yield* sql`UPDATE provider_session_runtime SET status = 'stopped'
          WHERE thread_id = ${session.threadId} AND provider_name = ${provider}`;
          }
        }
        const model = yield* engine.getReadModel();
        for (const thread of model.threads.filter((thread) => ids.has(thread.id))) {
          if (!thread.session || thread.session.status === "stopped") continue;
          if (thread.session.activeTurnId)
            return yield* fail(
              "A provider turn started while idle sessions were closing. Nothing was transferred.",
            );
          const observed = adapters.some(
            ({ provider, sessions }) =>
              provider === thread.session?.providerName &&
              sessions.some((session) => session.threadId === thread.id),
          );
          if (!observed)
            return yield* fail(
              `Thread '${thread.id}' has an unconfirmed session owner. Reconcile or stop it before changing folders.`,
            );
          const timestamp = new Date().toISOString();
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe(`workspace-stop-${crypto.randomUUID()}`),
            threadId: thread.id,
            createdAt: timestamp,
            expectedSessionEpoch: thread.session.sessionEpoch ?? 0,
            session: {
              ...thread.session,
              status: "stopped",
              activeTurnId: null,
              updatedAt: timestamp,
            },
          });
        }
      }),
    };
  });
}
