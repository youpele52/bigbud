import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { ModelSelection } from "@bigbud/contracts/orchestration/orchestration.provider.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import { withMetadataTransaction } from "./ThreadMetadataGeneration.transaction.ts";
import {
  makeLegacyMetadataEvidenceReader,
  type LegacyMetadataEvidence,
} from "./ThreadMetadataGeneration.legacy.ts";

type Operation = "title" | "summary";
type BlockReason = "unknown-evidence" | "legacy-paid-work" | "scan-limit";
export type LegacyMetadataAdmission =
  | {
      readonly allowed: true;
      readonly successfulModel: typeof ModelSelection.Type | null;
    }
  | { readonly allowed: false; readonly reason: BlockReason };

type ReadPage = Effect.Success<ReturnType<typeof makeLegacyMetadataEvidenceReader>>;
const MAX_PAGES = 100;
const SCAN_TIMEOUT = "2 seconds";
const OperationPayload = Schema.Struct({
  operation: Schema.Literals(["title", "summary", "branch", "promptSuggestion"]),
});
const UserTurnBinding = Schema.Struct({ messageId: Schema.NonEmptyString });
const RequestReference = Schema.Struct({ requestId: Schema.NonEmptyString });

/** A receipt proves this record was accepted, not that any provider work stopped.
 * Legacy statuses lack immutable dispatch identity and terminal provider receipts. In
 * particular neither a later completed/failed status nor request-settled clears a claim.
 */
export function legacyMetadataEvidenceBlocks(
  evidence: LegacyMetadataEvidence,
  operation: Operation,
): BlockReason | null {
  if (evidence.witness !== "accepted" || evidence.activity === null) return "unknown-evidence";
  const { kind, payload, turnId } = evidence.activity;
  if (kind === "text-generation.model-succeeded")
    return Schema.is(ModelSelection)(payload) ? null : "unknown-evidence";
  if (kind === "text-generation.user-turn-bound")
    return turnId && Schema.is(UserTurnBinding)(payload) ? null : "unknown-evidence";
  if (kind === "text-generation.request-settled")
    return Schema.is(RequestReference)(payload) ? null : "unknown-evidence";
  // A request owner is not operation-qualified. Keep it even when a later bookkeeping
  // settlement exists; it may have crossed an unrecorded provider dispatch boundary.
  if (kind === "text-generation.request-started") return "legacy-paid-work";
  if (kind === "text-generation.title-stage")
    return operation === "title" ? "legacy-paid-work" : null;
  if (!Schema.is(OperationPayload)(payload)) return "unknown-evidence";
  if (payload.operation !== operation) return null;
  if (kind === "text-generation.deferred" || kind === "text-generation.retry-requested")
    return null;
  return "legacy-paid-work";
}

/** Shared bounded canonical scan for model proof and operation-qualified admission.
 * Keep the caller's history/SQL barrier: partial history never establishes proof, and
 * a recovered selection is not a reusable dispatch capability or a replay witness.
 */
const scanLegacyMetadata = Effect.fn("scanLegacyMetadata")(function* (
  read: ReadPage,
  input: { readonly threadId: ThreadId; readonly operation?: Operation },
) {
  let afterKey: string | undefined;
  let successfulModel: typeof ModelSelection.Type | null = null;
  let successfulSequence = -1;
  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
    const page = yield* read({ threadId: input.threadId, ...(afterKey ? { afterKey } : {}) });
    for (const evidence of page.evidence) {
      const reason = legacyMetadataEvidenceBlocks(evidence, input.operation ?? "title");
      // Model recovery is proof of a selection, NEVER permission to replay paid work.
      // Still require a complete, unambiguous canonical history. Dispatch admission
      // independently retains the operation-qualified legacy-paid-work barrier.
      if (reason !== null && (input.operation !== undefined || reason !== "legacy-paid-work"))
        return { allowed: false, reason } satisfies LegacyMetadataAdmission;
      const activity = evidence.activity;
      if (
        activity?.kind === "text-generation.model-succeeded" &&
        Schema.is(ModelSelection)(activity.payload) &&
        evidence.sequence !== null &&
        evidence.sequence > successfulSequence
      ) {
        successfulModel = activity.payload;
        successfulSequence = evidence.sequence;
      }
    }
    if (page.nextKey === null)
      return { allowed: true, successfulModel } satisfies LegacyMetadataAdmission;
    // A stalled or regressing reader must not loop or accidentally qualify incomplete history.
    if (page.nextKey <= (afterKey ?? ""))
      return { allowed: false, reason: "scan-limit" } satisfies LegacyMetadataAdmission;
    afterKey = page.nextKey;
  }
  return { allowed: false, reason: "scan-limit" } satisfies LegacyMetadataAdmission;
});

export const scanLegacyMetadataAdmission = (
  read: ReadPage,
  input: { readonly threadId: ThreadId; readonly operation: Operation },
) => scanLegacyMetadata(read, input);

/** Full canonical evidence recovery only; this is not dispatch admission. */
export const scanLegacyMetadataSuccessfulModel = (read: ReadPage, threadId: ThreadId) =>
  scanLegacyMetadata(read, { threadId });

export const makeLegacyMetadataAdmission = Effect.fn("makeLegacyMetadataAdmission")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const read = yield* makeLegacyMetadataEvidenceReader();
  return Effect.fn("legacyMetadata.admission")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: Operation;
  }) {
    return yield* withMetadataTransaction(sql, scanLegacyMetadataAdmission(read, input)).pipe(
      Effect.mapError(toPersistenceSqlError("ThreadMetadataGeneration.legacy.admission")),
      Effect.timeoutOrElse({
        duration: SCAN_TIMEOUT,
        orElse: () =>
          Effect.succeed<LegacyMetadataAdmission>({ allowed: false, reason: "scan-limit" }),
      }),
    );
  });
});
