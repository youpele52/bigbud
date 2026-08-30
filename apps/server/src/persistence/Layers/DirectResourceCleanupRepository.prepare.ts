import { Data, Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type { DirectResourceCleanupRepositoryShape } from "../Services/DirectResourceCleanupRepository.ts";
import { paginateDirectCleanupResources } from "../../deletion/Layers/DirectResourceCleanup.request.ts";
import { serializeManagedWorktreeResource } from "./DirectResourceCleanupRepository.worktrees.ts";

const UINT64_MAX = 18_446_744_073_709_551_615n;

class CleanupPlanValidationError extends Data.TaggedError("CleanupPlanValidationError")<{
  readonly cause: unknown;
}> {}

function isCanonicalIdentityPart(value: string): boolean {
  try {
    const parsed = BigInt(value);
    return parsed >= 0n && parsed <= UINT64_MAX && parsed.toString(10) === value;
  } catch {
    return false;
  }
}

export function makeDirectResourceCleanupPreparation(
  sql: SqlClient.SqlClient,
): Pick<DirectResourceCleanupRepositoryShape, "prepare" | "loadPlan"> {
  return {
    loadPlan: (operationId) =>
      Effect.gen(function* () {
        const plans = yield* sql<{
          readonly operationId: string;
          readonly finalizePayloadJson: string;
          readonly finalizePayloadDigestVersion: string;
          readonly finalizePayloadDigest: string;
          readonly planDigest: string;
          readonly state: string;
        }>`
          SELECT operation_id AS "operationId", finalize_payload_json AS "finalizePayloadJson",
            finalize_payload_digest_version AS "finalizePayloadDigestVersion",
            finalize_payload_digest AS "finalizePayloadDigest", plan_digest AS "planDigest", state
          FROM direct_resource_cleanup_plans WHERE operation_id = ${operationId}
        `;
        if (!plans[0]) return undefined;
        const resources = yield* sql<{
          readonly resourceId: string;
          readonly kind: import("../../deletion/Services/DirectResourceCleanupExecutor.ts").DirectCleanupResource["kind"];
          readonly relativePath: string;
          readonly quarantineName: string;
          readonly entryType: "file" | "directory" | null;
          readonly resourceDevice: string | null;
          readonly resourceFileId: string | null;
          readonly rootDevice: string;
          readonly rootFileId: string;
          readonly parentDevice: string;
          readonly parentFileId: string;
          readonly pageOrdinal: number;
        }>`
          SELECT resource_id AS "resourceId", resource_kind AS kind,
            relative_path AS "relativePath", quarantine_name AS "quarantineName",
            entry_type AS "entryType", resource_device AS "resourceDevice",
            resource_file_id AS "resourceFileId", root_device AS "rootDevice",
            root_file_id AS "rootFileId", parent_device AS "parentDevice",
            parent_file_id AS "parentFileId", page_ordinal AS "pageOrdinal"
          FROM direct_resource_cleanup_resources
          WHERE operation_id = ${operationId}
            AND (outcome IS NULL OR outcome != 'retained_shared')
          ORDER BY original_index
        `;
        return {
          ...plans[0],
          resources: resources.map((resource) => {
            const mapped = {
              resourceId: resource.resourceId,
              kind: resource.kind,
              relativePath: resource.relativePath,
              quarantineName: resource.quarantineName,
              rootIdentity: {
                entryType: "directory" as const,
                deviceOrVolume: resource.rootDevice,
                inodeOrFileId: resource.rootFileId,
              },
              parentIdentity: {
                entryType: "directory" as const,
                deviceOrVolume: resource.parentDevice,
                inodeOrFileId: resource.parentFileId,
              },
              pageOrdinal: resource.pageOrdinal,
            };
            if (resource.entryType && resource.resourceDevice && resource.resourceFileId) {
              return Object.assign(mapped, {
                identity: {
                  entryType: resource.entryType,
                  deviceOrVolume: resource.resourceDevice,
                  inodeOrFileId: resource.resourceFileId,
                },
              });
            }
            return mapped;
          }),
        };
      }).pipe(Effect.mapError((error) => new Error(String(error)))),
    prepare: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<{
              readonly intentId: string;
              readonly finalizeCommandId: string;
              readonly finalizePayloadJson: string;
              readonly finalizePayloadDigestVersion: string;
              readonly finalizePayloadDigest: string;
              readonly planDigest: string;
              readonly expectedPlatform: string;
            }>`
              SELECT intent_id AS "intentId", finalize_command_id AS "finalizeCommandId",
                finalize_payload_json AS "finalizePayloadJson",
                finalize_payload_digest_version AS "finalizePayloadDigestVersion",
                finalize_payload_digest AS "finalizePayloadDigest",
                plan_digest AS "planDigest",
                expected_platform AS "expectedPlatform"
              FROM direct_resource_cleanup_plans WHERE operation_id = ${input.operationId}
            `;
            if (existing[0]) {
              if (
                existing[0].intentId !== input.intentId ||
                existing[0].finalizeCommandId !== input.finalizeCommandId ||
                existing[0].finalizePayloadJson !== input.finalizePayloadJson ||
                existing[0].finalizePayloadDigestVersion !== input.finalizePayloadDigestVersion ||
                existing[0].finalizePayloadDigest !== input.finalizePayloadDigest ||
                existing[0].planDigest !== input.planDigest ||
                existing[0].expectedPlatform !== input.expectedPlatform
              ) {
                return yield* Effect.fail(
                  new Error("cleanup operation conflicts with stored immutable command"),
                );
              }
              return;
            }
            if (
              input.resources.some((resource) =>
                [resource.identity, resource.rootIdentity, resource.parentIdentity]
                  .filter((identity) => identity !== undefined)
                  .some(
                    (identity) =>
                      !isCanonicalIdentityPart(identity.deviceOrVolume) ||
                      !isCanonicalIdentityPart(identity.inodeOrFileId),
                  ),
              )
            ) {
              return yield* Effect.fail(new Error("cleanup plan contains a malformed identity"));
            }
            const worktrees = yield* Effect.try({
              try: () =>
                (input.worktreeResources ?? []).map((resource) => {
                  const serialized = serializeManagedWorktreeResource(resource);
                  return {
                    resource: serialized.resource,
                    json: serialized.json,
                    digest: serialized.digest,
                    resourceId: `managed-worktree:${serialized.resource.relativePath}`,
                  };
                }),
              catch: (cause) => new CleanupPlanValidationError({ cause }),
            });
            if (
              new Set(worktrees.map((worktree) => worktree.resourceId)).size !== worktrees.length
            ) {
              return yield* Effect.fail(new Error("cleanup plan contains duplicate worktrees"));
            }
            const pages = paginateDirectCleanupResources({
              operationId: input.operationId,
              planDigest: input.planDigest,
              platform: input.expectedPlatform.startsWith("win32/")
                ? "windows"
                : input.expectedPlatform.startsWith("darwin/")
                  ? "macos"
                  : "linux",
              resources: input.resources,
            });
            const pageOrdinals = new Map(
              pages.flatMap((page, pageOrdinal) =>
                page.map((resource) => [resource.resourceId, pageOrdinal] as const),
              ),
            );
            yield* sql`
              INSERT INTO direct_resource_cleanup_plans (
                operation_id, intent_id, finalize_command_id, finalize_payload_json,
                finalize_payload_digest_version, finalize_payload_digest, plan_digest,
                expected_platform, state, created_at, updated_at
              ) VALUES (
                ${input.operationId}, ${input.intentId}, ${input.finalizeCommandId},
                ${input.finalizePayloadJson}, ${input.finalizePayloadDigestVersion},
                ${input.finalizePayloadDigest}, ${input.planDigest}, ${input.expectedPlatform},
                'prepared', ${input.createdAt}, ${input.createdAt}
              )
            `;
            yield* Effect.forEach(
              input.resources,
              (resource, index) =>
                sql`
                  INSERT INTO direct_resource_cleanup_resources (
                    operation_id, resource_id, original_index, page_ordinal, resource_kind,
                    root_kind, relative_path, quarantine_name, entry_type, resource_device,
                    resource_file_id, root_device, root_file_id, parent_device, parent_file_id
                  ) VALUES (
                    ${input.operationId}, ${resource.resourceId}, ${index},
                    ${pageOrdinals.get(resource.resourceId) ?? 0}, ${resource.kind}, ${resource.kind},
                    ${resource.relativePath}, ${resource.quarantineName},
                    ${resource.identity?.entryType ?? null},
                    ${resource.identity?.deviceOrVolume ?? null},
                    ${resource.identity?.inodeOrFileId ?? null},
                    ${resource.rootIdentity.deviceOrVolume}, ${resource.rootIdentity.inodeOrFileId},
                    ${resource.parentIdentity.deviceOrVolume}, ${resource.parentIdentity.inodeOrFileId}
                  )
                `,
              { concurrency: 1, discard: true },
            );
            yield* Effect.forEach(
              input.retainedResources ?? [],
              (resource, retainedIndex) =>
                sql`
                  INSERT INTO direct_resource_cleanup_resources (
                    operation_id, resource_id, original_index, page_ordinal, resource_kind,
                    root_kind, relative_path, quarantine_name, entry_type, resource_device,
                    resource_file_id, root_device, root_file_id, parent_device, parent_file_id,
                    outcome, terminal_at
                  ) VALUES (
                    ${input.operationId}, ${resource.resourceId},
                    ${input.resources.length + retainedIndex}, 0, ${resource.kind}, ${resource.kind},
                    ${resource.relativePath}, '.bigbud-cleanup-retained', NULL, NULL, NULL,
                    '0', '0', '0', '0', 'retained_shared', ${input.createdAt}
                  )
                `,
              { concurrency: 1, discard: true },
            );
            yield* Effect.forEach(
              worktrees,
              (worktree, originalIndex) =>
                sql`
                  INSERT INTO direct_resource_cleanup_worktrees (
                    operation_id, resource_id, original_index, resource_json, resource_digest,
                    state, created_at, updated_at
                  ) VALUES (
                    ${input.operationId}, ${worktree.resourceId}, ${originalIndex},
                    ${worktree.json}, ${worktree.digest}, 'pending', ${input.createdAt},
                    ${input.createdAt}
                  )
                `,
              { concurrency: 1, discard: true },
            );
          }),
        )
        .pipe(Effect.mapError((error) => new Error(String(error)))),
  };
}
