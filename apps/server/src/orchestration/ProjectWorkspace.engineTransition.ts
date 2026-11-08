import {
  EventId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationEvent,
} from "@bigbud/contracts";
import { MUSE_WORKSPACE_RESET_NOTICE } from "./ProjectWorkspace.nativeSessions.ts";
import { withProjectWorkspaceMutation } from "./ProjectWorkspace.mutation.ts";
import type { CommandEnvelope } from "./Layers/OrchestrationEngine.commandEnvelope.ts";
import type { makeWorktreeReservations } from "../git/Layers/WorktreeReservations.ts";
import { Effect } from "effect";
import { captureWorktreePathIdentity } from "../retention/worktreeRuntimeLease.ts";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { calculateCommandPayloadDigest } from "./commandDigest.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  assertProjectWorkspaceFinalize,
  finalizeProjectWorkspaceTransition,
  type ProjectWorkspaceFinalizeIdentity,
} from "./ProjectWorkspace.nativeFinalize.ts";
import { archiveMuseWorkspaceBinding } from "./ProjectWorkspace.museArchive.ts";
import { commitV2WorkspaceLineage } from "./ProjectWorkspace.v2Lineage.ts";

/** Internal dispatch option is not a client capability. Exact durable command evidence authorizes it. */
export function authorizeNativeWorkspaceCommit(
  sql: SqlClient.SqlClient,
  command: OrchestrationCommand,
  operationId?: string,
) {
  return Effect.gen(function* () {
    if (!operationId) return undefined;
    if (command.type !== "project.reconfigure" || !command.workspaceRoot)
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail:
          "Native workspace authorization is only valid for the exact project folder command.",
      });
    const identity: ProjectWorkspaceFinalizeIdentity = {
      operationId,
      commandId: command.commandId,
      projectId: command.projectId,
      destinationPath: command.workspaceRoot,
      requestDigest: calculateCommandPayloadDigest(command).digest,
    };
    yield* assertProjectWorkspaceFinalize(sql, identity);
    const muse =
      yield* sql`SELECT 1 FROM muse_session_bindings binding JOIN projection_threads thread USING(thread_id) WHERE thread.project_id = ${command.projectId} LIMIT 1`;
    if (muse.length && command.nativeContextReset !== "archive-and-reset-muse")
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail:
          "Explicit Muse native-context reset confirmation is required. Bigbud history stays; original native context is archived, not retained in the fresh session.",
      });
    const rows = yield* sql<{
      requestJson: string;
      sourcePath: string;
      sourceIdentity: string;
      destinationIdentity: string;
    }>`SELECT request_json AS "requestJson", source_path AS "sourcePath", source_identity_json AS "sourceIdentity", destination_identity_json AS "destinationIdentity" FROM project_workspace_native_operations WHERE operation_id = ${operationId}`;
    if (rows[0]?.requestJson !== JSON.stringify(command))
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail:
          "Native workspace retained request differs from this command. Nothing was finalized.",
      });
    for (const [directory, expected] of [
      [rows[0]!.sourcePath, rows[0]!.sourceIdentity],
      [command.workspaceRoot, rows[0]!.destinationIdentity],
    ] as const) {
      const actual = yield* Effect.tryPromise({
        try: () => captureWorktreePathIdentity(directory),
        catch: (cause) =>
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Workspace directory identity could not be confirmed: ${String(cause)}. Recovery remains fenced.`,
          }),
      });
      if (JSON.stringify(actual) !== expected)
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail:
            "Workspace source or destination directory identity changed. Recovery remains fenced; no native owner was rebound.",
        });
    }
    return identity;
  });
}

export function nativeWorkspaceCommitEvents(
  events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
  model: OrchestrationReadModel,
) {
  const result = [...events];
  for (const event of events) {
    if (event.type !== "thread.meta-updated") continue;
    const threadId = (
      event as Omit<Extract<OrchestrationEvent, { type: "thread.meta-updated" }>, "sequence">
    ).payload.threadId;
    const thread = model.threads.find((value) => value.id === threadId);
    if (thread?.session?.providerName !== "muse") continue;
    result.push({
      ...event,
      eventId: EventId.makeUnsafe(crypto.randomUUID()),
      type: "thread.session-set",
      payload: {
        threadId: thread.id,
        session: {
          ...thread.session,
          status: "stopped",
          activeTurnId: null,
          lastError: MUSE_WORKSPACE_RESET_NOTICE,
          updatedAt: event.occurredAt,
        },
      },
    });
  }
  return result;
}

export function assertWorkspaceCommandAdmission(
  sql: SqlClient.SqlClient,
  reservations: ReturnType<typeof makeWorktreeReservations>,
  envelope: CommandEnvelope,
) {
  return Effect.gen(function* () {
    const id = envelope.nativeWorkspaceOperationId;
    const pending = id
      ? yield* sql`SELECT 1 FROM worktree_operations WHERE operation_id = ${id} AND phase NOT IN ('completed','rejected')`
      : [];
    const authorization = pending.length
      ? yield* authorizeNativeWorkspaceCommit(sql, envelope.command, id)
      : undefined;
    yield* reservations.assertAllows(
      envelope.command,
      envelope.worktreeOperationId,
      envelope.expectedWorktreePath,
      envelope.expectedWorktreeIdentity,
      authorization?.operationId,
    );
  });
}

export function withWorkspaceCommandAdmission<A, E>(
  sql: SqlClient.SqlClient,
  command: OrchestrationCommand,
  readModel: OrchestrationReadModel,
  operationId: string | undefined,
  run: (identity: ProjectWorkspaceFinalizeIdentity | undefined) => Effect.Effect<A, E>,
) {
  return Effect.gen(function* () {
    const identity = yield* authorizeNativeWorkspaceCommit(sql, command, operationId);
    return yield* identity
      ? run(identity)
      : withProjectWorkspaceMutation(sql, command, readModel, run(undefined));
  });
}

export function commitProjectWorkspaceApplication<A extends { readonly lastSequence: number }, E>(
  sql: SqlClient.SqlClient,
  identity: ProjectWorkspaceFinalizeIdentity | undefined,
  application: Effect.Effect<A, E>,
) {
  if (!identity) return sql.withTransaction(application);
  return finalizeProjectWorkspaceTransition(
    sql,
    identity,
    Effect.gen(function* () {
      const owners = yield* sql<{
        provider: string;
        threadId: string;
        nativeSessionId: string;
        revision: number;
      }>`
      SELECT 'muse' AS provider, binding.thread_id AS "threadId", binding.native_session_id AS "nativeSessionId", binding.revision
      FROM muse_session_bindings binding JOIN projection_threads thread USING(thread_id)
      WHERE thread.project_id = ${identity.projectId}
      UNION ALL SELECT 'opencodeV2', binding.thread_id, json_extract(binding.material_json, '$.nativeSessionId'), binding.revision
      FROM opencode_v2_shared_bindings binding JOIN projection_threads thread USING(thread_id)
      WHERE thread.project_id = ${identity.projectId}`;
      for (const owner of owners) {
        const input = {
          operationId: identity.operationId,
          threadId: owner.threadId,
          nativeSessionId: owner.nativeSessionId,
          revision: owner.revision,
        };
        yield* (
          owner.provider === "muse"
            ? archiveMuseWorkspaceBinding(sql, input)
            : commitV2WorkspaceLineage(sql, input)
        ).pipe(
          Effect.catchTag("GitCommandError", (cause) =>
            Effect.fail(
              new OrchestrationCommandInvariantError({
                commandType: "project.reconfigure",
                detail: cause.message,
              }),
            ),
          ),
        );
      }
      const result = yield* application;
      return { ...result, sequence: result.lastSequence };
    }),
  );
}
