import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema } from "effect";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  ReserveThreadDelegationInput,
  StoreThreadDelegationResultInput,
  ThreadDelegation,
  ThreadDelegationByChild,
  ThreadDelegationInvocation,
  ThreadDelegationRepository,
  type ThreadDelegationRepositoryShape,
  UpdateThreadDelegationStateInput,
} from "../Services/ThreadDelegations.ts";

function mapError(operation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(`${operation}:decode`)(cause)
      : toPersistenceSqlError(`${operation}:query`)(cause);
}

const makeThreadDelegationRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const getByInvocation = SqlSchema.findOneOption({
    Request: ThreadDelegationInvocation,
    Result: ThreadDelegation,
    execute: ({ callerThreadId, sourceMessageId, invocationId }) => sql`
      SELECT
        delegation_id AS "delegationId",
        caller_thread_id AS "callerThreadId",
        source_message_id AS "sourceMessageId",
        invocation_id AS "invocationId",
        parent_delegation_id AS "parentDelegationId",
        root_delegation_id AS "rootDelegationId",
        depth,
        target_kind AS "targetKind",
        target_project_id AS "targetProjectId",
        target_canonical_workspace AS "targetCanonicalWorkspace",
        child_thread_id AS "childThreadId",
        child_turn_id AS "childTurnId",
        created_project_id AS "createdProjectId",
        state,
        result_json AS "resultJson",
        error_json AS "errorJson",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM thread_delegations
      WHERE caller_thread_id = ${callerThreadId}
        AND source_message_id = ${sourceMessageId}
        AND invocation_id = ${invocationId}
      LIMIT 1
    `,
  });
  const findDirectByChild = SqlSchema.findOneOption({
    Request: ThreadDelegationByChild,
    Result: ThreadDelegation,
    execute: ({ childThreadId }) => sql`
      SELECT
        delegation_id AS "delegationId",
        caller_thread_id AS "callerThreadId",
        source_message_id AS "sourceMessageId",
        invocation_id AS "invocationId",
        parent_delegation_id AS "parentDelegationId",
        root_delegation_id AS "rootDelegationId",
        depth,
        target_kind AS "targetKind",
        target_project_id AS "targetProjectId",
        target_canonical_workspace AS "targetCanonicalWorkspace",
        child_thread_id AS "childThreadId",
        child_turn_id AS "childTurnId",
        created_project_id AS "createdProjectId",
        state,
        result_json AS "resultJson",
        error_json AS "errorJson",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM thread_delegations
      WHERE child_thread_id = ${childThreadId}
      LIMIT 1
    `,
  });
  const reserve = SqlSchema.findOne({
    Request: ReserveThreadDelegationInput,
    Result: ThreadDelegation,
    execute: (input) => sql`
      INSERT INTO thread_delegations (
        delegation_id, caller_thread_id, source_message_id, invocation_id,
        parent_delegation_id, root_delegation_id, depth,
        target_kind, target_project_id, target_canonical_workspace,
        child_thread_id, child_turn_id, created_project_id,
        state, result_json, error_json, created_at, updated_at
      ) VALUES (
        ${input.delegationId}, ${input.callerThreadId}, ${input.sourceMessageId}, ${input.invocationId},
        ${input.parentDelegationId}, ${input.rootDelegationId}, ${input.depth},
        ${input.targetKind}, ${input.targetProjectId}, ${input.targetCanonicalWorkspace},
        ${input.childThreadId}, ${input.childTurnId}, ${input.createdProjectId},
        'reserved', NULL, NULL, ${input.createdAt}, ${input.updatedAt}
      ) ON CONFLICT (caller_thread_id, source_message_id, invocation_id)
      DO UPDATE SET delegation_id = delegation_id
      RETURNING
        delegation_id AS "delegationId",
        caller_thread_id AS "callerThreadId",
        source_message_id AS "sourceMessageId",
        invocation_id AS "invocationId",
        parent_delegation_id AS "parentDelegationId",
        root_delegation_id AS "rootDelegationId",
        depth,
        target_kind AS "targetKind",
        target_project_id AS "targetProjectId",
        target_canonical_workspace AS "targetCanonicalWorkspace",
        child_thread_id AS "childThreadId",
        child_turn_id AS "childTurnId",
        created_project_id AS "createdProjectId",
        state,
        result_json AS "resultJson",
        error_json AS "errorJson",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `,
  });
  const updateState = SqlSchema.void({
    Request: UpdateThreadDelegationStateInput,
    execute: ({ delegationId, state, updatedAt }) => sql`
      UPDATE thread_delegations
      SET state = ${state}, updated_at = ${updatedAt}
      WHERE delegation_id = ${delegationId}
    `,
  });
  const storeResult = SqlSchema.void({
    Request: StoreThreadDelegationResultInput,
    execute: ({ delegationId, resultJson, errorJson, updatedAt }) => sql`
      UPDATE thread_delegations
      SET result_json = ${resultJson}, error_json = ${errorJson}, updated_at = ${updatedAt}
      WHERE delegation_id = ${delegationId}
    `,
  });

  return {
    getByInvocation: (input) =>
      getByInvocation(input).pipe(
        Effect.mapError(mapError("ThreadDelegationRepository.getByInvocation")),
      ),
    reserve: (input) =>
      reserve(input).pipe(Effect.mapError(mapError("ThreadDelegationRepository.reserve"))),
    updateState: (input) =>
      updateState(input).pipe(Effect.mapError(mapError("ThreadDelegationRepository.updateState"))),
    storeResult: (input) =>
      storeResult(input).pipe(Effect.mapError(mapError("ThreadDelegationRepository.storeResult"))),
    findDirectByChild: (input) =>
      findDirectByChild(input).pipe(
        Effect.mapError(mapError("ThreadDelegationRepository.findDirectByChild")),
      ),
  } satisfies ThreadDelegationRepositoryShape;
});

export const ThreadDelegationRepositoryLive = Layer.effect(
  ThreadDelegationRepository,
  makeThreadDelegationRepository,
);
