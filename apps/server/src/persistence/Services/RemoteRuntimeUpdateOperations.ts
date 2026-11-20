import { Schema, ServiceMap } from "effect";
import type * as Effect from "effect/Effect";
import {
  RemoteRuntimeUpdateConsentState,
  RemoteRuntimeUpdateOperationId,
  RemoteRuntimeUpdateRequestId,
  RemoteRuntimeUpdateSource,
  RemoteRuntimeUpdateState,
  RemoteRuntimeUpdateVersion,
} from "@bigbud/contracts/server/remoteBackendUpdate.ts";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

/** One persisted update operation (migration 174). Never stores tokens or credentials. */
export const RemoteRuntimeUpdateRecord = Schema.Struct({
  operationId: RemoteRuntimeUpdateOperationId,
  requestId: RemoteRuntimeUpdateRequestId,
  version: RemoteRuntimeUpdateVersion,
  source: RemoteRuntimeUpdateSource,
  state: RemoteRuntimeUpdateState,
  interruptRequested: Schema.Boolean,
  archiveKey: Schema.NullOr(Schema.String.check(Schema.isMaxLength(256))),
  consentState: RemoteRuntimeUpdateConsentState,
  consentDigest: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  failure: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1024))),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type RemoteRuntimeUpdateRecord = typeof RemoteRuntimeUpdateRecord.Type;

/** Fields a compare-and-set may change; `live` always follows `state`. */
export type RemoteRuntimeUpdatePatch = Partial<
  Pick<
    RemoteRuntimeUpdateRecord,
    "state" | "interruptRequested" | "archiveKey" | "consentState" | "consentDigest" | "failure"
  >
> & { readonly updatedAt: string };

/** The expected current values; the update applies only when every given field matches. */
export interface RemoteRuntimeUpdateExpectation {
  readonly states: ReadonlyArray<RemoteRuntimeUpdateState>;
  readonly consentState?: RemoteRuntimeUpdateRecord["consentState"];
}

/** Another non-terminal operation already holds the single-flight slot. */
export class RemoteRuntimeUpdateLiveConflict extends Schema.TaggedErrorClass<RemoteRuntimeUpdateLiveConflict>()(
  "RemoteRuntimeUpdateLiveConflict",
  { detail: Schema.String },
) {}

export type RemoteRuntimeUpdateRepositoryError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | RemoteRuntimeUpdateLiveConflict;

type Find = Effect.Effect<
  RemoteRuntimeUpdateRecord | undefined,
  RemoteRuntimeUpdateRepositoryError
>;

export interface RemoteRuntimeUpdateOperationsShape {
  readonly get: (operationId: string) => Find;
  readonly findByRequestId: (requestId: string) => Find;
  /** The single non-terminal operation, if any. */
  readonly findLive: () => Find;
  /** The most recently created operation, live or settled. */
  readonly findLatest: () => Find;
  /** Inserts a new live operation; fails with a live conflict when one already exists. */
  readonly insert: (
    record: RemoteRuntimeUpdateRecord,
  ) => Effect.Effect<RemoteRuntimeUpdateRecord, RemoteRuntimeUpdateRepositoryError>;
  /** Atomic compare-and-set; undefined when the expectation no longer holds. */
  readonly compareAndSet: (
    operationId: string,
    expect: RemoteRuntimeUpdateExpectation,
    patch: RemoteRuntimeUpdatePatch,
  ) => Find;
}

export class RemoteRuntimeUpdateOperations extends ServiceMap.Service<
  RemoteRuntimeUpdateOperations,
  RemoteRuntimeUpdateOperationsShape
>()("bigbud/persistence/RemoteRuntimeUpdateOperations") {}
