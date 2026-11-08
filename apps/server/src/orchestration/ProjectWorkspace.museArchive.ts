import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { assertInactiveWorktreeThread } from "../git/Layers/WorktreeReferences.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

/** Called only from the atomic finalizer before it records result_sequence. No native session
 * is started, historic selection guessed, admission deleted, or other provider cursor changed.
 */
export function archiveMuseWorkspaceBinding(
  sql: SqlClient.SqlClient,
  input: {
    readonly operationId: string;
    readonly threadId: string;
    readonly nativeSessionId: string;
    readonly revision: number;
  },
) {
  const fail = (detail: string) =>
    new OrchestrationCommandInvariantError({ commandType: "project.reconfigure", detail });
  return sql.withTransaction(
    Effect.gen(function* () {
      const operations = yield* sql<{
        sourcePath: string;
      }>`SELECT native.source_path AS "sourcePath"
      FROM project_workspace_native_operations native JOIN worktree_operations operation USING(operation_id)
      JOIN projection_threads thread ON thread.project_id = native.project_id
      WHERE native.operation_id = ${input.operationId} AND thread.thread_id = ${input.threadId}
        AND native.phase = 'committed' AND native.result_sequence IS NULL AND operation.phase = 'completed'`;
      if (operations.length !== 1)
        return yield* fail(
          "Muse archival requires the owning atomic workspace finalization. Nothing was reset.",
        );
      yield* assertInactiveWorktreeThread(sql, input.threadId);
      const bindings = yield* sql<{
        native_session_id: string;
        workspace: string;
        phase: string;
        revision: number;
      }>`SELECT * FROM muse_session_bindings WHERE thread_id = ${input.threadId}`;
      const binding = bindings[0];
      if (
        !binding ||
        binding.native_session_id !== input.nativeSessionId ||
        binding.revision !== input.revision ||
        binding.phase !== "bound" ||
        binding.workspace !== operations[0]!.sourcePath
      ) {
        return yield* fail(
          "Muse binding is uncertain or changed since preparation. The workspace reset must be reconciled before retrying.",
        );
      }
      const admissions = yield* sql<{
        namespace: string;
        owner_thread_id: string;
        request_message_id: string;
        binding_json: string;
        state: string;
      }>`SELECT * FROM provider_turn_admissions
      WHERE CASE WHEN json_valid(binding_json) THEN json_extract(binding_json, '$.threadId') END = ${input.threadId}
      AND CASE WHEN json_valid(binding_json) THEN json_extract(binding_json, '$.provider') END = 'muse'
      AND NOT EXISTS (SELECT 1 FROM provider_workspace_archived_admissions archived
        WHERE archived.namespace = provider_turn_admissions.namespace
          AND archived.owner_thread_id = provider_turn_admissions.owner_thread_id
          AND archived.request_message_id = provider_turn_admissions.request_message_id)`;
      if (admissions.some((row) => row.state !== "terminal"))
        return yield* fail("Muse native admissions have not settled. Nothing was reset.");
      const runtime =
        yield* sql`SELECT * FROM provider_session_runtime WHERE thread_id = ${input.threadId} AND provider_name = 'muse'`;
      const projection =
        yield* sql`SELECT * FROM projection_thread_sessions WHERE thread_id = ${input.threadId} AND provider_name = 'muse'`;
      const groups = new Map<string, Array<(typeof admissions)[number]>>();
      groups.set(input.nativeSessionId, []);
      for (const admission of admissions) {
        const owner = JSON.parse(admission.binding_json) as {
          nativeSessionId?: unknown;
          location?: unknown;
        };
        if (
          typeof owner.nativeSessionId !== "string" ||
          !owner.nativeSessionId ||
          typeof owner.location !== "string" ||
          !owner.location
        )
          return yield* fail("Muse historical native ownership is invalid. Nothing was reset.");
        const group = groups.get(owner.nativeSessionId) ?? [];
        group.push(admission);
        groups.set(owner.nativeSessionId, group);
      }
      for (const [nativeSessionId, history] of groups) {
        const workspaceRoot =
          nativeSessionId === input.nativeSessionId
            ? binding.workspace
            : (JSON.parse(history[0]!.binding_json) as { location: string }).location;
        const archiveId = JSON.stringify([
          input.operationId,
          input.threadId,
          "muse",
          nativeSessionId,
        ]);
        const recovery = JSON.stringify({
          binding: nativeSessionId === input.nativeSessionId ? binding : null,
          runtime: nativeSessionId === input.nativeSessionId ? runtime : [],
          projection: nativeSessionId === input.nativeSessionId ? projection : [],
          admissions: history,
        });
        yield* sql`INSERT INTO provider_workspace_binding_archives
        (archive_id, operation_id, thread_id, provider, native_session_id, workspace_root, recovery_json, created_at)
        VALUES (${archiveId}, ${input.operationId}, ${input.threadId}, 'muse', ${nativeSessionId},
          ${workspaceRoot}, ${recovery}, ${new Date().toISOString()})`;
        for (const admission of history)
          yield* sql`INSERT INTO provider_workspace_archived_admissions
        (archive_id, namespace, owner_thread_id, request_message_id)
        VALUES (${archiveId}, ${admission.namespace}, ${admission.owner_thread_id}, ${admission.request_message_id})`;
      }
      // Old provider-specific cursors leave the active view only after durable recovery capture.
      yield* sql`DELETE FROM muse_session_bindings WHERE thread_id = ${input.threadId}
      AND native_session_id = ${input.nativeSessionId} AND revision = ${input.revision}`;
      yield* sql`DELETE FROM provider_session_runtime WHERE thread_id = ${input.threadId} AND provider_name = 'muse'`;
      yield* sql`DELETE FROM projection_thread_sessions WHERE thread_id = ${input.threadId} AND provider_name = 'muse'`;
      return { archivedNativeSessions: groups.size };
    }),
  );
}
