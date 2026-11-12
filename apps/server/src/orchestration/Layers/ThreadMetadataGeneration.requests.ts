import type { ChatAttachment } from "@bigbud/contracts/orchestration/orchestration.attachments.ts";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type * as Effect from "effect/Effect";
import type { MetadataCoordinatorFailure } from "./ThreadMetadataGeneration.coordinator.types.ts";

export interface MetadataTitleRequest {
  readonly threadId: ThreadId;
  readonly messageText: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly titleSeed?: string;
  /** Stable explicit retry request identity, not an automatically regenerated UUID. */
  readonly retryKey?: string;
  /** Accepted explicit consent, bound to this same stable retry identity. */
  readonly legacyRecoveryRequestId?: string;
}
export interface MetadataSummaryRequest {
  readonly threadId: ThreadId;
  readonly force?: boolean;
  readonly retryKey?: string;
  /** Accepted explicit consent, bound to this same stable retry identity. */
  readonly legacyRecoveryRequestId?: string;
}
export interface ThreadMetadataGenerationRequests {
  readonly title: (input: MetadataTitleRequest) => Effect.Effect<void, MetadataCoordinatorFailure>;
  readonly summary: (
    input: MetadataSummaryRequest,
  ) => Effect.Effect<void, MetadataCoordinatorFailure>;
  readonly start: () => Effect.Effect<void>;
}
