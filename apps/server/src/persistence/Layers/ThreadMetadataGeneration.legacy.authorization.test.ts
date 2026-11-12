import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { makeLegacyMetadataAdmission } from "./ThreadMetadataGeneration.legacy.admission.ts";
import {
  captureLegacyMetadataClaims,
  MAX_RECOVERY_CLAIMS,
} from "./ThreadMetadataGeneration.legacy.authorization.ts";
import { at, seedActivity, seedThread } from "./ThreadMetadataGeneration.legacy.test-helpers.ts";

describe("recovery authorization proof", () => {
  for (const mode of [
    "valid",
    "no-consent",
    "wrong-consent",
    "malformed-claim",
    "too-many",
    "bad-sequence",
    "bad-version",
    "changed-projection",
    "other-thread",
  ] as const) {
    it.effect(`requires complete scoped proof: ${mode}`, () =>
      Effect.gen(function* () {
        const threadId = yield* seedThread(`authorization-${mode}`);
        const other = yield* seedThread(`other-${mode}`);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_command_receipt_claims
        (command_id, payload_digest_version, payload_digest, claimed_at)
        VALUES ('server:text-generation-status:historical', 'unknown', 'unchanged', ${at})`;
        const claims = yield* captureLegacyMetadataClaims();
        assert.strictEqual(claims.length, 1);
        const id = `text-generation-recovery:${mode}`;
        const payload = {
          requestId: id,
          sourceActivityId: mode,
          operation: "title",
          legacyRecovery: {
            ...(mode === "no-consent"
              ? {}
              : {
                  acknowledgement:
                    mode === "wrong-consent"
                      ? "yes"
                      : "authorize-new-budget-with-unresolved-history",
                }),
            claims:
              mode === "malformed-claim"
                ? [{ commandId: claims[0]!.commandId }]
                : mode === "too-many"
                  ? Array.from({ length: MAX_RECOVERY_CLAIMS + 1 }, () => claims[0]!)
                  : claims,
          },
        };
        const command = yield* seedActivity(
          mode === "other-thread" ? other : threadId,
          id,
          "text-generation.retry-requested",
          payload,
        );
        if (mode === "bad-sequence")
          yield* sql`UPDATE orchestration_command_receipts SET result_sequence = result_sequence + 1 WHERE command_id = ${command.commandId}`;
        if (mode === "bad-version")
          yield* sql`UPDATE orchestration_command_receipts SET payload_digest_version = 'unknown' WHERE command_id = ${command.commandId}`;
        if (mode === "changed-projection")
          yield* sql`UPDATE projection_thread_activities SET payload_json = ${JSON.stringify({ ...payload, sourceActivityId: "tampered" })} WHERE activity_id = ${id}`;
        const admit = yield* makeLegacyMetadataAdmission();
        assert.strictEqual(
          (yield* admit({ threadId, operation: "title", legacyRecoveryRequestId: id })).allowed,
          mode === "valid",
        );
        assert.isFalse((yield* admit({ threadId, operation: "title" })).allowed);
        assert.isFalse(
          (yield* admit({ threadId, operation: "summary", legacyRecoveryRequestId: id })).allowed,
        );
        assert.deepStrictEqual(yield* captureLegacyMetadataClaims(), claims);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
    );
  }
});
