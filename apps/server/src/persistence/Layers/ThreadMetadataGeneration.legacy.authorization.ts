import { MetadataRecoveryAcknowledgement } from "@bigbud/contracts/server/rpc.textGeneration.ts";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { textGenerationStatusPrefix } from "../../git/Layers/InternalTextGeneration.statusIdentity.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";

export const LegacyMetadataClaim = Schema.Struct({
  commandId: Schema.NonEmptyString,
  digestVersion: Schema.NonEmptyString,
  digest: Schema.NonEmptyString,
  claimedAt: Schema.NonEmptyString,
});
export type LegacyMetadataClaim = typeof LegacyMetadataClaim.Type;
export const LegacyMetadataAuthorization = Schema.Struct({
  acknowledgement: MetadataRecoveryAcknowledgement,
  claims: Schema.Array(LegacyMetadataClaim),
});
export const MAX_RECOVERY_CLAIMS = 32;

/** Snapshot ONLY unowned status claims. This is authorization to spend a NEW budget,
 * never evidence of settlement. Canonical request acceptance makes the snapshot immutable.
 * Claim timestamps are exact identity fields, not chronological admission authority.
 */
export const captureLegacyMetadataClaims = Effect.fn("captureLegacyMetadataClaims")(function* (
  threadId?: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  const prefix = threadId === undefined ? null : `server:${textGenerationStatusPrefix(threadId)}`;
  return yield* sql<LegacyMetadataClaim>`
    SELECT c.command_id AS "commandId", c.payload_digest_version AS "digestVersion",
      c.payload_digest AS digest, c.claimed_at AS "claimedAt"
    FROM orchestration_command_receipt_claims c
    WHERE (c.command_id LIKE 'server:text-generation-status:%'
      OR (${prefix} IS NOT NULL AND substr(c.command_id, 1, length(${prefix})) = ${prefix}))
      AND NOT EXISTS (SELECT 1 FROM orchestration_command_receipts r
        WHERE r.command_id = c.command_id)
      AND NOT EXISTS (SELECT 1 FROM projection_thread_activities a
        WHERE a.activity_id = substr(c.command_id, 8) AND a.kind LIKE 'text-generation.%')
    ORDER BY c.command_id LIMIT ${MAX_RECOVERY_CLAIMS + 1}
  `.pipe(Effect.mapError(toPersistenceSqlError("ThreadMetadataGeneration.captureRecoveryClaims")));
});

export function sameLegacyMetadataClaim(a: LegacyMetadataClaim, b: LegacyMetadataClaim) {
  return (
    a.commandId === b.commandId &&
    a.digestVersion === b.digestVersion &&
    a.digest === b.digest &&
    a.claimedAt === b.claimedAt
  );
}
