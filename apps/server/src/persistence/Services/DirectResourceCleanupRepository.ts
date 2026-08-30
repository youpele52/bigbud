import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { DirectCleanupResource } from "../../deletion/Services/DirectResourceCleanupExecutor.ts";
import type { DirectCleanupResult } from "../../deletion/Services/DirectResourceCleanupExecutor.ts";

export interface DirectCleanupPlanInput {
  readonly operationId: string;
  readonly intentId: string;
  readonly finalizeCommandId: string;
  readonly finalizePayloadJson: string;
  readonly finalizePayloadDigestVersion: string;
  readonly finalizePayloadDigest: string;
  readonly planDigest: string;
  readonly expectedPlatform: string;
  readonly resources: ReadonlyArray<DirectCleanupResource>;
  readonly retainedResources?: ReadonlyArray<{
    readonly resourceId: string;
    readonly kind: "attachment";
    readonly relativePath: string;
  }>;
  readonly createdAt: string;
}

export interface DirectCleanupProofInput {
  readonly operationId: string;
  readonly aggregateKind: "thread" | "project";
  readonly aggregateId: string;
  readonly payloadDigestVersion: string;
  readonly payloadDigest: string;
  readonly eventId: string;
  readonly eventSequence: number;
  readonly eventType: string;
  readonly eventPayloadJson: string;
  readonly provenAt: string;
}

export interface DirectResourceCleanupRepositoryShape {
  readonly prepare: (input: DirectCleanupPlanInput) => Effect.Effect<void, Error>;
  readonly loadPlan: (operationId: string) => Effect.Effect<
    | {
        readonly operationId: string;
        readonly finalizePayloadJson: string;
        readonly finalizePayloadDigestVersion: string;
        readonly finalizePayloadDigest: string;
        readonly planDigest: string;
        readonly state: string;
        readonly resources: ReadonlyArray<
          Omit<DirectCleanupResource, "root"> & { readonly pageOrdinal: number }
        >;
      }
    | undefined,
    Error
  >;
  readonly markFinalizeCommitted: (input: DirectCleanupProofInput) => Effect.Effect<void, Error>;
  readonly listCanonicalPruning: (limit: number) => Effect.Effect<
    ReadonlyArray<{
      readonly operationId: string;
      readonly threadId: string;
      readonly deletionSequence: number;
    }>,
    Error
  >;
  readonly markCanonicalPruned: (operationId: string, at: string) => Effect.Effect<void, Error>;
  readonly cancelPrepared: (operationId: string, at: string) => Effect.Effect<void, Error>;
  readonly cancelIntentIfUnplanned: (intentId: string, at: string) => Effect.Effect<void, Error>;
  readonly recordResults: (
    operationId: string,
    leaseId: string,
    attemptId: string,
    results: ReadonlyArray<DirectCleanupResult>,
    at: string,
    retry?: { readonly errorCode: string; readonly nextAttemptAt: string },
  ) => Effect.Effect<void, Error>;
  readonly scheduleRetry: (
    operationId: string,
    leaseId: string,
    errorCode: string,
    nextAttemptAt: string,
    incrementAttempt: boolean,
  ) => Effect.Effect<void, Error>;
  readonly block: (
    operationId: string,
    errorCode: string,
    at: string,
  ) => Effect.Effect<void, Error>;
  readonly complete: (
    operationId: string,
    at: string,
    leaseId?: string,
  ) => Effect.Effect<void, Error>;
  readonly claimOperation: (input: {
    readonly operationId: string;
    readonly leaseId: string;
    readonly claimedAt: string;
    readonly expiresAt: string;
    readonly expectedPlatform: string;
  }) => Effect.Effect<boolean, Error>;
  readonly claimReady: (input: {
    readonly leaseId: string;
    readonly claimedAt: string;
    readonly expiresAt: string;
    readonly expectedPlatform: string;
  }) => Effect.Effect<
    | {
        readonly operationId: string;
        readonly attemptCount: number;
        readonly planDigest: string;
        readonly proofDigest: string;
        readonly resources: ReadonlyArray<{
          readonly resourceId: string;
          readonly kind: DirectCleanupResource["kind"];
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
        }>;
      }
    | undefined,
    Error
  >;
  readonly releaseLease: (operationId: string, leaseId: string) => Effect.Effect<void, Error>;
  readonly renewLease: (input: {
    readonly operationId: string;
    readonly leaseId: string;
    readonly renewedAt: string;
    readonly expiresAt: string;
  }) => Effect.Effect<boolean, Error>;
  readonly prepareAttempt: (input: {
    readonly attemptId: string;
    readonly operationId: string;
    readonly pageOrdinal: number;
    readonly pageDigest: string;
    readonly resourceIds: ReadonlyArray<string>;
    readonly requestJson: string;
    readonly requestFrameHex: string;
    readonly deadlineUnixMs: number;
    readonly leaseId: string;
    readonly at: string;
  }) => Effect.Effect<void, Error>;
  readonly markAttempt: (
    attemptId: string,
    state: "sent" | "recorded" | "ambiguous",
    at: string,
    leaseId: string,
  ) => Effect.Effect<void, Error>;
  readonly loadAmbiguousAttempt: (
    operationId: string,
    pageOrdinal: number,
  ) => Effect.Effect<
    | {
        readonly attemptId: string;
        readonly pageDigest: string;
        readonly resourceIds: ReadonlyArray<string>;
        readonly requestJson: string;
        readonly requestFrameHex: string;
        readonly deadlineUnixMs: number;
      }
    | undefined,
    Error
  >;
  readonly reconcilePrepared: (
    at: string,
    expectedPlatform: string,
  ) => Effect.Effect<number, Error>;
  /** Indexed startup candidates whose canonical deletion projection is still live. */
  readonly listRecoverableIntents: (input: {
    readonly requestedAfter: string;
    readonly intentAfter: string;
    readonly limit: number;
  }) => Effect.Effect<
    ReadonlyArray<{
      readonly intentId: string;
      readonly eventId: string;
      readonly commandId: string;
      readonly requestedAt: string;
    }>,
    Error
  >;
}

export class DirectResourceCleanupRepository extends ServiceMap.Service<
  DirectResourceCleanupRepository,
  DirectResourceCleanupRepositoryShape
>()("bigbud/persistence/Services/DirectResourceCleanupRepository") {}
