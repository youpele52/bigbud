/**
 * OrchestrationCommandReceiptRepository - Repository interface for command receipts.
 *
 * Owns persistence operations for deduplication and status tracking of
 * orchestration command handling.
 *
 * @module OrchestrationCommandReceiptRepository
 */
import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationAggregateKind,
  OrchestrationCommandReceiptStatus,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts";
import { OrchestrationCommandRejectionReason } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { OrchestrationCommandReceiptRepositoryError } from "../Errors.ts";

export const OrchestrationCommandReceipt = Schema.Struct({
  commandId: CommandId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  acceptedAt: IsoDateTime,
  resultSequence: NonNegativeInt,
  status: OrchestrationCommandReceiptStatus,
  rejectionReason: Schema.NullOr(OrchestrationCommandRejectionReason),
  error: Schema.NullOr(Schema.String),
  payloadDigestVersion: Schema.NullOr(Schema.String),
  payloadDigest: Schema.NullOr(Schema.String),
});
export type OrchestrationCommandReceipt = typeof OrchestrationCommandReceipt.Type;

export const GetByCommandIdInput = Schema.Struct({
  commandId: CommandId,
});
export type GetByCommandIdInput = typeof GetByCommandIdInput.Type;

export const ClaimCommandReceiptInput = Schema.Struct({
  commandId: CommandId,
  payloadDigestVersion: Schema.String,
  payloadDigest: Schema.String,
  claimedAt: IsoDateTime,
});
export type ClaimCommandReceiptInput = typeof ClaimCommandReceiptInput.Type;

export type CommandReceiptClaimResult =
  | {
      readonly status: "claimed";
    }
  | {
      readonly status: "existing";
      readonly receipt: OrchestrationCommandReceipt;
    }
  | {
      readonly status: "conflict";
      readonly storedPayloadDigestVersion: string;
      readonly storedPayloadDigest: string;
    };

/**
 * OrchestrationCommandReceiptRepositoryShape - Service API for command receipts.
 */
export interface OrchestrationCommandReceiptRepositoryShape {
  /**
   * Insert or replace a command receipt row.
   *
   * Upserts by `commandId` for idempotent command-result tracking.
   */
  readonly upsert: (
    receipt: OrchestrationCommandReceipt,
  ) => Effect.Effect<void, OrchestrationCommandReceiptRepositoryError>;

  /**
   * Read a command receipt by command id.
   */
  readonly getByCommandId: (
    input: GetByCommandIdInput,
  ) => Effect.Effect<
    Option.Option<OrchestrationCommandReceipt>,
    OrchestrationCommandReceiptRepositoryError
  >;

  /**
   * Atomically claim a command id for a canonical payload digest or inspect the
   * existing claim/terminal receipt.
   */
  readonly claimOrInspect: (
    input: ClaimCommandReceiptInput,
  ) => Effect.Effect<CommandReceiptClaimResult, OrchestrationCommandReceiptRepositoryError>;
}

/**
 * OrchestrationCommandReceiptRepository - Service tag for command receipt persistence.
 */
export class OrchestrationCommandReceiptRepository extends ServiceMap.Service<
  OrchestrationCommandReceiptRepository,
  OrchestrationCommandReceiptRepositoryShape
>()("t3/persistence/Services/OrchestrationCommandReceipts/OrchestrationCommandReceiptRepository") {}
