import { ThreadId } from "@bigbud/contracts";
import { decodeJsonResult } from "@bigbud/shared/schemaJson";
import { Effect, Result } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { purgeManifestDigest } from "../../persistence/PurgeManifest.ts";
import {
  PurgeJobRepository,
  PurgeResourceManifest,
  type PurgeJob,
  type PurgeResource,
} from "../../persistence/Services/PurgeJobRepository.ts";
import { ServerConfig } from "../../startup/config.ts";
import { makeEntityPurgeClaims } from "./EntityPurge.claims.ts";
import { makeEntityPurgeSql } from "./EntityPurge.sql.ts";
import {
  captureResourceIdentity,
  deleteResourceAtomically,
  resolvePurgeResource,
} from "./EntityPurge.resources.ts";

export const LEGACY_PURGE_MANIFEST_RECOVERY_JOB_LIMIT = 25;
export const LEGACY_PURGE_MANIFEST_RECOVERY_RESOURCE_LIMIT = 100;

const decodeManifest = decodeJsonResult(PurgeResourceManifest);

type ManualJobRow = {
  readonly jobId: string;
  readonly entityKind: "project" | "thread";
  readonly entityId: string;
  readonly phase: PurgeJob["phase"];
  readonly status: PurgeJob["status"];
  readonly resourceManifestJson: string;
  readonly manifestDigest: string | null;
  readonly manifestSealedAt: string | null;
  readonly attemptCount: number;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
};

export interface LegacyResourceCandidate {
  readonly job: PurgeJob;
  readonly resource: PurgeResource;
}

export interface LegacyPurgeManifestRecoveryResult {
  readonly processedJobCount: number;
  readonly resourceCount: number;
  readonly deduplicatedResourceCount: number;
  readonly deletedCount: number;
  readonly retainedCount: number;
  readonly malformedCount: number;
  readonly failedCount: number;
}

function resourceKey(resource: PurgeResource): string | null {
  const identity = resource.identity;
  if (identity === null) return null;
  return [
    resource.kind,
    resource.relativePath,
    identity.canonicalPath,
    identity.device,
    identity.inode,
    identity.type,
  ].join("\u0000");
}

export function isRecoverableLegacyResource(candidate: LegacyResourceCandidate): boolean {
  return (
    candidate.job.entityKind === "thread" &&
    candidate.resource.action === "delete" &&
    (candidate.resource.kind === "attachment" ||
      candidate.resource.kind === "provider-log" ||
      candidate.resource.kind === "terminal-history" ||
      candidate.resource.kind === "managed-worktree")
  );
}

export function deduplicateLegacyPurgeResources(
  candidates: ReadonlyArray<LegacyResourceCandidate>,
): ReadonlyArray<ReadonlyArray<LegacyResourceCandidate>> {
  const groups = new Map<string, LegacyResourceCandidate[]>();
  for (const candidate of candidates) {
    const key = resourceKey(candidate.resource);
    if (key === null) continue;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export const runLegacyPurgeManifestRecovery = Effect.fn("runLegacyPurgeManifestRecovery")(
  function* (apply: boolean, limit = LEGACY_PURGE_MANIFEST_RECOVERY_JOB_LIMIT) {
    const sql = yield* SqlClient.SqlClient;
    const config = yield* ServerConfig;
    const jobs = yield* PurgeJobRepository;
    const rows = yield* sql<ManualJobRow>`
      SELECT job_id AS "jobId", entity_kind AS "entityKind", entity_id AS "entityId", phase, status,
        resource_manifest_json AS "resourceManifestJson", resource_manifest_digest AS "manifestDigest",
        manifest_sealed_at AS "manifestSealedAt", attempt_count AS "attemptCount",
        last_error AS "lastError", created_at AS "createdAt", updated_at AS "updatedAt",
        completed_at AS "completedAt"
      FROM purge_jobs
      WHERE status = 'failed' AND auto_resume_disabled = 1
        AND last_error = 'manual_recovery_required'
      ORDER BY updated_at ASC, job_id ASC
      LIMIT ${Math.min(LEGACY_PURGE_MANIFEST_RECOVERY_JOB_LIMIT, Math.max(1, Math.floor(limit)))}
    `;
    const candidates: LegacyResourceCandidate[] = [];
    let malformedCount = 0;
    let retainedCount = 0;
    for (const row of rows) {
      const decoded = decodeManifest(row.resourceManifestJson);
      if (Result.isFailure(decoded)) {
        malformedCount += 1;
        continue;
      }
      const job = { ...row, resourceManifest: decoded.success } satisfies PurgeJob;
      for (const resource of job.resourceManifest) {
        if (candidates.length >= LEGACY_PURGE_MANIFEST_RECOVERY_RESOURCE_LIMIT) break;
        const candidate = { job, resource };
        if (!isRecoverableLegacyResource(candidate)) {
          retainedCount += 1;
          continue;
        }
        if (
          row.manifestSealedAt === null ||
          row.manifestDigest !== purgeManifestDigest(decoded.success) ||
          resourceKey(resource) === null ||
          resource.quarantineName === null
        ) {
          malformedCount += 1;
          continue;
        }
        candidates.push(candidate);
      }
    }
    const groups = deduplicateLegacyPurgeResources(candidates);
    if (!apply) {
      return {
        processedJobCount: rows.length,
        resourceCount: candidates.length,
        deduplicatedResourceCount: groups.length,
        deletedCount: 0,
        retainedCount,
        malformedCount,
        failedCount: 0,
      } satisfies LegacyPurgeManifestRecoveryResult;
    }

    const queries = makeEntityPurgeSql(sql);
    const captureResource = (kind: PurgeResource["kind"], relativePath: string) =>
      Effect.tryPromise(() => {
        const resource: PurgeResource = {
          kind,
          relativePath,
          identity: null,
          quarantineName: `.bigbud-purge-${crypto.randomUUID()}`,
          action: "delete",
        };
        return captureResourceIdentity(resolvePurgeResource(config, resource)).then((identity) => ({
          ...resource,
          identity,
        }));
      }).pipe(
        Effect.mapError(toPersistenceSqlError("LegacyPurgeManifestRecovery.captureResource")),
      );
    const claims = makeEntityPurgeClaims({
      config,
      queries,
      captureResource,
      resourceOperation: (operation, run) =>
        Effect.tryPromise(run).pipe(Effect.mapError(toPersistenceSqlError(operation))),
      jobs,
      sql,
    });
    let deletedCount = 0;
    let failedCount = 0;
    for (const group of groups) {
      const candidate = group[0]!;
      const outcome = yield* Effect.exit(
        Effect.gen(function* () {
          yield* claims.assertResourceExclusive(candidate.job, candidate.resource);
          if (
            candidate.resource.kind === "attachment" &&
            (yield* claims.attachmentIsShared(
              ThreadId.makeUnsafe(candidate.job.entityId),
              candidate.resource,
            ))
          ) {
            return false;
          }
          return (yield* Effect.tryPromise(() =>
            deleteResourceAtomically({
              jobId: candidate.job.jobId,
              resolved: resolvePurgeResource(config, candidate.resource),
              resource: candidate.resource,
            }),
          )).removed;
        }),
      );
      if (outcome._tag === "Failure") {
        failedCount += group.length;
      } else if (outcome.value) {
        deletedCount += group.length;
      } else {
        retainedCount += group.length;
      }
    }
    return {
      processedJobCount: rows.length,
      resourceCount: candidates.length,
      deduplicatedResourceCount: groups.length,
      deletedCount,
      retainedCount,
      malformedCount,
      failedCount,
    } satisfies LegacyPurgeManifestRecoveryResult;
  },
);
