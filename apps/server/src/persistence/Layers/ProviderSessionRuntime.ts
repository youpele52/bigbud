import { ThreadId } from "@bigbud/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Data, Effect, Layer, Option, Schema, Struct } from "effect";

import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { captureLocalRuntimePathIdentity } from "../../retention/worktreeRuntimeLease.ts";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProviderSessionRuntimeRepositoryError,
} from "../Errors.ts";
import {
  ProviderSessionRuntime,
  ProviderSessionRuntimeRepository,
  type ProviderSessionRuntimeRepositoryShape,
} from "../Services/ProviderSessionRuntime.ts";

const ProviderSessionRuntimeDbRowSchema = ProviderSessionRuntime.mapFields(
  Struct.assign({
    resumeCursor: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
    runtimePayload: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
  }),
);

const decodeRuntime = Schema.decodeUnknownEffect(ProviderSessionRuntime);

class ProviderWorkspaceIdentityError extends Data.TaggedError("ProviderWorkspaceIdentityError")<{
  readonly cause: unknown;
}> {}

const GetRuntimeRequestSchema = Schema.Struct({
  threadId: ThreadId,
});

const DeleteRuntimeRequestSchema = GetRuntimeRequestSchema;

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProviderSessionRuntimeRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

function runtimeCwd(payload: unknown | null): string | null {
  return typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    "cwd" in payload &&
    typeof payload.cwd === "string" &&
    payload.cwd.length > 0
    ? payload.cwd
    : null;
}

const captureProviderLeaseIdentity = Effect.fn("captureProviderLeaseIdentity")(function* (
  runtime: typeof ProviderSessionRuntime.Type,
) {
  if (!isLocalExecutionTarget(runtime.workspaceExecutionTargetId)) {
    return null;
  }
  const cwd = runtimeCwd(runtime.runtimePayload);
  if (!cwd) return null;
  return yield* Effect.tryPromise({
    try: () => captureLocalRuntimePathIdentity(cwd),
    catch: (cause) => new ProviderWorkspaceIdentityError({ cause }),
  }).pipe(
    Effect.catch((error) =>
      typeof error.cause === "object" &&
      error.cause !== null &&
      "code" in error.cause &&
      (error.cause.code === "ENOENT" || error.cause.code === "ENOTDIR")
        ? Effect.succeed(null)
        : Effect.fail(
            toPersistenceSqlError("ProviderSessionRuntimeRepository.upsert:workspaceIdentity")(
              error.cause,
            ),
          ),
    ),
  );
});

const makeProviderSessionRuntimeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    DELETE FROM worktree_runtime_leases AS lease
    WHERE lease.runtime_kind = 'provider' AND NOT EXISTS (
      SELECT 1 FROM provider_session_runtime AS runtime
      WHERE runtime.thread_id = lease.thread_id AND runtime.status IN ('starting', 'running')
    )
  `;

  const upsertRuntimeRow = SqlSchema.void({
    Request: ProviderSessionRuntimeDbRowSchema,
    execute: (runtime) =>
      sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          adapter_key,
          provider_runtime_execution_target_id,
          workspace_execution_target_id,
          execution_target_id,
          runtime_mode,
          status,
          last_seen_at,
          resume_cursor_json,
          runtime_payload_json
        )
        VALUES (
          ${runtime.threadId},
          ${runtime.providerName},
          ${runtime.adapterKey},
          ${runtime.providerRuntimeExecutionTargetId},
          ${runtime.workspaceExecutionTargetId},
          ${runtime.executionTargetId},
          ${runtime.runtimeMode},
          ${runtime.status},
          ${runtime.lastSeenAt},
          ${runtime.resumeCursor},
          ${runtime.runtimePayload}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          provider_name = excluded.provider_name,
          adapter_key = excluded.adapter_key,
          provider_runtime_execution_target_id = excluded.provider_runtime_execution_target_id,
          workspace_execution_target_id = excluded.workspace_execution_target_id,
          execution_target_id = excluded.execution_target_id,
          runtime_mode = excluded.runtime_mode,
          status = excluded.status,
          last_seen_at = excluded.last_seen_at,
          resume_cursor_json = excluded.resume_cursor_json,
          runtime_payload_json = excluded.runtime_payload_json
      `,
  });

  const getRuntimeRowByThreadId = SqlSchema.findOneOption({
    Request: GetRuntimeRequestSchema,
    Result: ProviderSessionRuntimeDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          provider_name AS "providerName",
          adapter_key AS "adapterKey",
          provider_runtime_execution_target_id AS "providerRuntimeExecutionTargetId",
          workspace_execution_target_id AS "workspaceExecutionTargetId",
          execution_target_id AS "executionTargetId",
          runtime_mode AS "runtimeMode",
          status,
          last_seen_at AS "lastSeenAt",
          resume_cursor_json AS "resumeCursor",
          runtime_payload_json AS "runtimePayload"
        FROM provider_session_runtime
        WHERE thread_id = ${threadId}
      `,
  });

  const listRuntimeRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProviderSessionRuntimeDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          provider_name AS "providerName",
          adapter_key AS "adapterKey",
          provider_runtime_execution_target_id AS "providerRuntimeExecutionTargetId",
          workspace_execution_target_id AS "workspaceExecutionTargetId",
          execution_target_id AS "executionTargetId",
          runtime_mode AS "runtimeMode",
          status,
          last_seen_at AS "lastSeenAt",
          resume_cursor_json AS "resumeCursor",
          runtime_payload_json AS "runtimePayload"
        FROM provider_session_runtime
        ORDER BY last_seen_at ASC, thread_id ASC
      `,
  });

  const deleteRuntimeByThreadId = SqlSchema.void({
    Request: DeleteRuntimeRequestSchema,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM provider_session_runtime
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProviderSessionRuntimeRepositoryShape["upsert"] = Effect.fn(
    "ProviderSessionRuntimeRepository.upsert",
  )(function* (runtime) {
    const active = runtime.status === "starting" || runtime.status === "running";
    const identity = active ? yield* captureProviderLeaseIdentity(runtime) : null;
    yield* sql
      .withTransaction(
        upsertRuntimeRow(runtime).pipe(
          Effect.andThen(
            identity
              ? sql`
                  INSERT INTO worktree_runtime_leases (
                    lease_id, thread_id, runtime_kind, canonical_path, device, inode,
                    acquired_at, updated_at
                  ) VALUES (
                    ${`provider:${runtime.threadId}`}, ${runtime.threadId}, 'provider',
                    ${identity.canonicalPath}, ${identity.device}, ${identity.inode},
                    ${runtime.lastSeenAt}, ${runtime.lastSeenAt}
                  ) ON CONFLICT (lease_id) DO UPDATE SET
                    canonical_path = excluded.canonical_path, device = excluded.device,
                    inode = excluded.inode, updated_at = excluded.updated_at
                `.pipe(Effect.asVoid)
              : sql`DELETE FROM worktree_runtime_leases
                  WHERE lease_id = ${`provider:${runtime.threadId}`}`.pipe(Effect.asVoid),
          ),
        ),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProviderSessionRuntimeRepository.upsert:query",
            "ProviderSessionRuntimeRepository.upsert:encodeRequest",
          ),
        ),
      );
  });

  const getByThreadId: ProviderSessionRuntimeRepositoryShape["getByThreadId"] = (input) =>
    getRuntimeRowByThreadId(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderSessionRuntimeRepository.getByThreadId:query",
          "ProviderSessionRuntimeRepository.getByThreadId:decodeRow",
        ),
      ),
      Effect.flatMap((runtimeRowOption) =>
        Option.match(runtimeRowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            decodeRuntime(row).pipe(
              Effect.mapError(
                toPersistenceDecodeError(
                  "ProviderSessionRuntimeRepository.getByThreadId:rowToRuntime",
                ),
              ),
              Effect.map((runtime) => Option.some(runtime)),
            ),
        }),
      ),
    );

  const list: ProviderSessionRuntimeRepositoryShape["list"] = () =>
    listRuntimeRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderSessionRuntimeRepository.list:query",
          "ProviderSessionRuntimeRepository.list:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows,
          (row) =>
            decodeRuntime(row).pipe(
              Effect.mapError(
                toPersistenceDecodeError("ProviderSessionRuntimeRepository.list:rowToRuntime"),
              ),
            ),
          { concurrency: "unbounded" },
        ),
      ),
    );

  const deleteByThreadId: ProviderSessionRuntimeRepositoryShape["deleteByThreadId"] = (input) =>
    sql
      .withTransaction(
        sql`DELETE FROM worktree_runtime_leases
          WHERE lease_id = ${`provider:${input.threadId}`}`.pipe(
          Effect.andThen(deleteRuntimeByThreadId(input)),
        ),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlError("ProviderSessionRuntimeRepository.deleteByThreadId:query"),
        ),
      );

  return {
    upsert,
    getByThreadId,
    list,
    deleteByThreadId,
  } satisfies ProviderSessionRuntimeRepositoryShape;
});

export const ProviderSessionRuntimeRepositoryLive = Layer.effect(
  ProviderSessionRuntimeRepository,
  makeProviderSessionRuntimeRepository,
);
