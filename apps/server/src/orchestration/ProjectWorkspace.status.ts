import type { CommandId } from "@bigbud/contracts";
import { ProjectWorkspaceTransitionStatus } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";
import { Effect, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceSqlError } from "../persistence/Errors.ts";

/** Inspection only. Never clears a fence, repeats a move, or launches a provider. */
export function readProjectWorkspaceStatus(sql: SqlClient.SqlClient, commandId: CommandId) {
  return Effect.gen(function* () {
    const installed =
      yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_workspace_native_operations'`;
    if (!installed.length) return undefined;
    const rows = yield* sql<{
      operationId: string;
      phase: string;
      sourcePath: string;
      destinationPath: string;
      error: string | null;
      stepsJson: string;
    }>`
      SELECT operation_id AS "operationId", phase, source_path AS "sourcePath", destination_path AS "destinationPath", error,
      steps_json AS "stepsJson" FROM project_workspace_native_operations WHERE command_id = ${commandId}`;
    if (!rows[0]) return undefined;
    const { stepsJson, ...row } = rows[0];
    return yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(ProjectWorkspaceTransitionStatus)({
          ...row,
          steps: JSON.parse(stepsJson),
        }),
      catch: toPersistenceSqlError("projectWorkspace.status.decode"),
    });
  }).pipe(Effect.mapError(toPersistenceSqlError("projectWorkspace.status")));
}
