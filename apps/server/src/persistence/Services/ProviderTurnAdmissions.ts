import type {
  ProviderTurnAdmission,
  ProviderTurnAdmissionIdentity,
  ProviderTurnAdmissionState,
} from "@bigbud/contracts/orchestration/providerTurnAdmission.ts";
import { ServiceMap, Schema } from "effect";
import type * as Effect from "effect/Effect";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";

import type { PersistenceSqlError, PersistenceDecodeError } from "../Errors.ts";

export class ProviderTurnAdmissionConflict extends Schema.TaggedErrorClass<ProviderTurnAdmissionConflict>()(
  "ProviderTurnAdmissionConflict",
  { detail: Schema.String },
) {}

export type ProviderTurnAdmissionError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | ProviderTurnAdmissionConflict;

export interface ProviderTurnAdmissionsShape {
  readonly assertOwnerAvailable: (
    threadId: ThreadId,
  ) => Effect.Effect<void, ProviderTurnAdmissionError>;
  /** Stable immutable-key pagination; unrelated owners cannot starve startup recovery. */
  readonly listBoundPage: (input: {
    readonly threadId: ThreadId;
    readonly limit: number;
    readonly unresolvedOnly?: boolean;
    readonly after?: Pick<
      ProviderTurnAdmission,
      "createdAt" | "namespace" | "ownerThreadId" | "requestMessageId"
    >;
  }) => Effect.Effect<readonly ProviderTurnAdmission[], ProviderTurnAdmissionError>;
  /** Lossless payload compression, never expiry/deletion of identity or replay evidence. */
  readonly compactTerminal: (limit: number) => Effect.Effect<number, ProviderTurnAdmissionError>;
  readonly listBound: (
    threadId: ThreadId,
    limit: number,
  ) => Effect.Effect<readonly ProviderTurnAdmission[], ProviderTurnAdmissionError>;
  /** Retained terminal evidence supports recovery after canonical-delivery failure. */
  readonly latestBound: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderTurnAdmission | undefined, ProviderTurnAdmissionError>;
  readonly reserve: (
    input: Omit<
      ProviderTurnAdmission,
      "state" | "revision" | "finalText" | "updatedAt" | "terminalOutcome"
    >,
  ) => Effect.Effect<ProviderTurnAdmission, ProviderTurnAdmissionError>;
  readonly find: (
    identity: ProviderTurnAdmissionIdentity,
  ) => Effect.Effect<ProviderTurnAdmission | undefined, ProviderTurnAdmissionError>;
  /** Compare-and-swap prevents concurrent attempts from both acquiring dispatch. */
  readonly transition: (
    current: ProviderTurnAdmission,
    state: ProviderTurnAdmissionState,
    updatedAt: string,
    finalText?: string,
    terminalOutcome?: ProviderTurnAdmission["terminalOutcome"],
  ) => Effect.Effect<ProviderTurnAdmission, ProviderTurnAdmissionError>;
  readonly listUnresolved: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<ProviderTurnAdmission>, ProviderTurnAdmissionError>;
}

export class ProviderTurnAdmissions extends ServiceMap.Service<
  ProviderTurnAdmissions,
  ProviderTurnAdmissionsShape
>()("bigbud/persistence/ProviderTurnAdmissions") {}
