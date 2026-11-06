import { Effect, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { OpencodeV2SharedBinding } from "../persistence/Services/OpencodeV2SharedBindings.ts";
import { assertInactiveWorktreeThread } from "../git/Layers/WorktreeReferences.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

/** Apply only application-owned binding/lineage changes after official native move verification.
 * Native databases, deterministic IDs, historical admission fingerprints and messages are untouched.
 */
export function commitV2WorkspaceLineage(
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
  const decode = (json: string) =>
    Effect.try({
      try: () => JSON.parse(json) as unknown,
      catch: () => fail("V2 workspace recovery evidence is invalid. Nothing was rebound."),
    });
  const record = (json: string) =>
    decode(json).pipe(
      Effect.flatMap((value) =>
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? Effect.succeed(value as Record<string, unknown>)
          : Effect.fail(fail("V2 workspace recovery record is invalid. Nothing was rebound.")),
      ),
    );
  return sql.withTransaction(
    Effect.gen(function* () {
      const operations = yield* sql<{
        stepsJson: string;
        sourcePath: string;
        destinationPath: string;
      }>`SELECT native.steps_json AS "stepsJson",
      native.source_path AS "sourcePath", native.destination_path AS "destinationPath"
      FROM project_workspace_native_operations native JOIN worktree_operations operation USING(operation_id)
      JOIN projection_threads thread ON thread.project_id = native.project_id
      WHERE native.operation_id = ${input.operationId} AND thread.thread_id = ${input.threadId}
        AND native.phase = 'committed' AND native.result_sequence IS NULL AND operation.phase = 'completed'`;
      if (operations.length !== 1)
        return yield* fail(
          "V2 Location lineage requires the owning atomic workspace finalization. Nothing was rebound.",
        );
      const steps = yield* decode(operations[0]!.stepsJson);
      const step = Array.isArray(steps)
        ? (steps.find(
            (value) =>
              value?.provider === "opencodeV2" &&
              value.threadId === input.threadId &&
              value.nativeSessionId === input.nativeSessionId &&
              value.phase === "verified",
          ) as
            | {
                sourceDirectory?: unknown;
                destinationDirectory?: unknown;
                storageIdentity?: unknown;
                expectedIdentity?: unknown;
              }
            | undefined)
        : undefined;
      if (
        !step ||
        typeof step.sourceDirectory !== "string" ||
        typeof step.destinationDirectory !== "string" ||
        step.sourceDirectory === step.destinationDirectory ||
        !step.expectedIdentity ||
        step.sourceDirectory !== operations[0]!.sourcePath ||
        step.destinationDirectory !== operations[0]!.destinationPath
      ) {
        return yield* fail(
          "V2 native move is not durably verified for this exact owner. Nothing was rebound.",
        );
      }
      yield* assertInactiveWorktreeThread(sql, input.threadId);
      const rows = yield* sql<{ materialJson: string; state: string; revision: number }>`SELECT
      material_json AS "materialJson", state, revision FROM opencode_v2_shared_bindings WHERE thread_id = ${input.threadId}`;
      const row = rows[0];
      if (!row)
        return yield* fail("V2 retained shared binding is unavailable. Recovery is required.");
      const material = yield* record(row.materialJson);
      const binding = yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(OpencodeV2SharedBinding)({
            ...material,
            state: row.state,
            revision: row.revision,
          }),
        catch: () => fail("V2 retained shared binding is invalid. Recovery is required."),
      });
      if (
        binding.state !== "verified" ||
        binding.revision !== input.revision ||
        binding.nativeSessionId !== input.nativeSessionId ||
        binding.storageIdentity !== step.storageIdentity ||
        binding.directory !== step.sourceDirectory ||
        binding.runtimeTargetId !== "local" ||
        binding.workspaceTargetId !== "local"
      ) {
        return yield* fail(
          "V2 native ownership changed since move preparation. Nothing was rebound.",
        );
      }
      const admissions = yield* sql`SELECT * FROM provider_turn_admissions
      WHERE CASE WHEN json_valid(binding_json) THEN
        json_extract(binding_json, '$.threadId') = ${input.threadId}
        AND json_extract(binding_json, '$.provider') = 'opencodeV2'
        AND json_extract(binding_json, '$.nativeSessionId') = ${input.nativeSessionId}
        AND json_extract(binding_json, '$.storageIdentity') = ${binding.storageIdentity}
      ELSE 0 END`;
      const runtime = yield* sql<{
        resume_cursor_json: string | null;
        runtime_payload_json: string | null;
      }>`
      SELECT * FROM provider_session_runtime WHERE thread_id = ${input.threadId} AND provider_name = 'opencodeV2'`;
      const archiveId = JSON.stringify([
        input.operationId,
        input.threadId,
        "opencodeV2",
        input.nativeSessionId,
      ]);
      yield* sql`INSERT INTO provider_workspace_binding_archives
      (archive_id, operation_id, thread_id, provider, native_session_id, workspace_root, recovery_json, created_at)
      VALUES (${archiveId}, ${input.operationId}, ${input.threadId}, 'opencodeV2', ${input.nativeSessionId},
        ${binding.directory}, ${JSON.stringify({ binding: row, runtime, admissions })}, ${new Date().toISOString()})`;
      yield* sql`INSERT INTO provider_workspace_location_lineage
      (operation_id, thread_id, provider, native_session_id, storage_identity, old_location, new_location, verified_at)
      VALUES (${input.operationId}, ${input.threadId}, 'opencodeV2', ${input.nativeSessionId},
        ${binding.storageIdentity}, ${step.sourceDirectory}, ${step.destinationDirectory}, ${new Date().toISOString()})`;
      yield* sql`UPDATE opencode_v2_shared_bindings SET material_json = ${JSON.stringify({ ...material, directory: step.destinationDirectory })}, revision = revision + 1
      WHERE thread_id = ${input.threadId} AND revision = ${input.revision}`;
      for (const current of runtime) {
        const cursor = current.resume_cursor_json
          ? yield* record(current.resume_cursor_json)
          : null;
        const payload = current.runtime_payload_json
          ? yield* record(current.runtime_payload_json)
          : null;
        if (
          cursor &&
          (cursor.nativeSessionId !== input.nativeSessionId ||
            cursor.storageIdentity !== binding.storageIdentity ||
            cursor.directory !== step.sourceDirectory)
        ) {
          return yield* fail(
            "V2 active cursor does not match the verified moved owner. Recovery is required.",
          );
        }
        yield* sql`UPDATE provider_session_runtime
        SET resume_cursor_json = ${cursor ? JSON.stringify({ ...cursor, directory: step.destinationDirectory }) : null},
            runtime_payload_json = ${payload ? JSON.stringify({ ...payload, cwd: step.destinationDirectory }) : null}
        WHERE thread_id = ${input.threadId} AND provider_name = 'opencodeV2'`;
      }
    }),
  );
}
