import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { makeLegacyMetadataAdmission } from "./ThreadMetadataGeneration.legacy.admission.ts";
import { makeLegacyMetadataEvidenceReader } from "./ThreadMetadataGeneration.legacy.ts";
import { at, seedActivity, seedThread } from "./ThreadMetadataGeneration.legacy.test-helpers.ts";
import { recordThreadTextGenerationStatusRequired } from "../../git/Layers/InternalTextGeneration.status.ts";
import { calculateCommandPayloadDigest } from "../../orchestration/commandDigest.ts";
import { captureLegacyMetadataClaims } from "./ThreadMetadataGeneration.legacy.authorization.ts";

it.layer(SqlitePersistenceMemory)("orphan legacy metadata safety", (it) => {
  it.effect("an interrupted status write fences only its owner and remains recoverable", () =>
    Effect.gen(function* () {
      const owner = yield* seedThread("owner:with%separators");
      const other = yield* seedThread("owner");
      const sql = yield* SqlClient.SqlClient;
      yield* recordThreadTextGenerationStatusRequired(
        {
          dispatch: (command) =>
            Effect.gen(function* () {
              const digest = calculateCommandPayloadDigest(command);
              yield* sql`INSERT INTO orchestration_command_receipt_claims
            (command_id, payload_digest_version, payload_digest, claimed_at)
            VALUES (${command.commandId}, ${digest.version}, ${digest.digest}, ${at})`;
              return { sequence: 1 };
            }).pipe(Effect.orDie),
        },
        owner,
        "title",
        "started",
      );
      const admit = yield* makeLegacyMetadataAdmission();
      assert.isFalse((yield* admit({ threadId: owner, operation: "title" })).allowed);
      assert.isTrue((yield* admit({ threadId: other, operation: "title" })).allowed);
      const read = yield* makeLegacyMetadataEvidenceReader();
      const claims = yield* captureLegacyMetadataClaims(owner);
      assert.equal(claims.length, 1);
      assert.deepStrictEqual(
        (yield* read({ threadId: owner })).evidence[0]?.orphanClaim,
        claims[0],
      );
      assert.deepStrictEqual(yield* captureLegacyMetadataClaims(other), []);
    }),
  );

  it.effect("an arbitrary command claim cannot hide a canonical dispatch record", () =>
    Effect.gen(function* () {
      const threadId = yield* seedThread("legacy-orphan-claim-event");
      const command = yield* seedActivity(
        threadId,
        "paid-claim-event",
        "text-generation.started",
        {
          operation: "title",
        },
        false,
      );
      const sql = yield* SqlClient.SqlClient;
      const commandId = "provider:unknown-dispatch-identity";
      yield* sql`UPDATE orchestration_events SET command_id = ${commandId} WHERE command_id = ${command.commandId}`;
      yield* sql`DELETE FROM projection_thread_activities WHERE activity_id = ${command.activity.id}`;
      yield* sql`INSERT INTO orchestration_command_receipt_claims
        (command_id, payload_digest_version, payload_digest, claimed_at)
        VALUES (${commandId}, 'unknown', 'retained', ${at})`;
      const read = yield* makeLegacyMetadataEvidenceReader();
      const page = yield* read({ threadId });
      assert.strictEqual(page.evidence.length, 1);
      assert.strictEqual(page.evidence[0]?.commandId, commandId);
      assert.strictEqual(page.evidence[0]?.witness, "unknown");
      const admit = yield* makeLegacyMetadataAdmission();
      assert.isFalse((yield* admit({ threadId, operation: "title" })).allowed);
      assert.deepStrictEqual(
        yield* sql`SELECT payload_digest FROM orchestration_command_receipt_claims WHERE command_id = ${commandId}`,
        [{ payload_digest: "retained" }],
      );
    }),
  );

  for (const fault of ["malformed", "missing-kind"] as const) {
    for (const receipt of [true, false]) {
      it.effect(`preserves ${fault} canonical evidence with receipt=${receipt}`, () =>
        Effect.gen(function* () {
          const id = `orphan-${fault}-${receipt}`;
          const threadId = yield* seedThread(id);
          const command = yield* seedActivity(
            threadId,
            id,
            "text-generation.started",
            {
              operation: "summary",
            },
            receipt,
          );
          const sql = yield* SqlClient.SqlClient;
          const commandId = `provider:${id}`;
          const payload =
            fault === "malformed" ? "{broken" : JSON.stringify({ threadId, activity: { id } });
          yield* sql`UPDATE orchestration_events SET command_id = ${commandId}, payload_json = ${payload} WHERE command_id = ${command.commandId}`;
          yield* sql`UPDATE orchestration_command_receipts SET command_id = ${commandId} WHERE command_id = ${command.commandId}`;
          yield* sql`DELETE FROM projection_thread_activities WHERE activity_id = ${id}`;
          const read = yield* makeLegacyMetadataEvidenceReader();
          const page = yield* read({ threadId });
          assert.strictEqual(page.evidence.length, 1);
          assert.strictEqual(page.evidence[0]?.commandId, commandId);
          assert.strictEqual(page.evidence[0]?.witness, "unknown");
          const admit = yield* makeLegacyMetadataAdmission();
          assert.isFalse((yield* admit({ threadId, operation: "summary" })).allowed);
        }),
      );
    }
  }
});
