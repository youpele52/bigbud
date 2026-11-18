import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { calculateCommandPayloadDigest } from "../../orchestration/commandDigest.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { makeLegacyMetadataAdmission } from "./ThreadMetadataGeneration.legacy.admission.ts";
import { makeLegacyMetadataEvidenceReader } from "./ThreadMetadataGeneration.legacy.ts";
import { seedActivity, seedThread } from "./ThreadMetadataGeneration.legacy.test-helpers.ts";

it.layer(SqlitePersistenceMemory)("legacy canonical authority", (it) => {
  for (const fault of ["missing", "kind", "payload"] as const) {
    it.effect(`does not verify model evidence with a ${fault} canonical event`, () =>
      Effect.gen(function* () {
        const threadId = yield* seedThread(`legacy-authority-${fault}`);
        const command = yield* seedActivity(
          threadId,
          `authority-${fault}`,
          "text-generation.model-succeeded",
          {
            provider: "codex",
            model: "verified",
          },
        );
        const sql = yield* SqlClient.SqlClient;
        if (fault === "missing")
          yield* sql`DELETE FROM orchestration_events WHERE command_id = ${command.commandId}`;
        else {
          const activity = {
            ...command.activity,
            ...(fault === "kind"
              ? { kind: "text-generation.started" }
              : { payload: { provider: "codex", model: "different" } }),
          };
          yield* sql`UPDATE orchestration_events
            SET payload_json = ${JSON.stringify({ threadId, activity })}
            WHERE command_id = ${command.commandId}`;
        }
        const read = yield* makeLegacyMetadataEvidenceReader();
        const page = yield* read({ threadId });
        assert.isTrue(page.evidence.every((item) => item.witness === "unknown"));
        const admit = yield* makeLegacyMetadataAdmission();
        assert.deepStrictEqual(yield* admit({ threadId, operation: "title" }), {
          allowed: false,
          reason: "unknown-evidence",
        });
      }),
    );
  }

  it.effect("retains an older canonical dispatch when its projected identity was reused", () =>
    Effect.gen(function* () {
      const threadId = yield* seedThread("legacy-authority-reused-id");
      const original = yield* seedActivity(
        threadId,
        "authority-reused-id",
        "text-generation.started",
        { operation: "title" },
        false,
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_thread_activities SET kind = 'text-generation.model-succeeded',
        payload_json = '{"provider":"codex","model":"verified"}' WHERE activity_id = ${original.activity.id}`;
      const newer = yield* seedActivity(
        threadId,
        "authority-newer",
        "text-generation.model-succeeded",
        { provider: "codex", model: "verified" },
      );
      const latestActivity = { ...newer.activity, id: original.activity.id };
      const latestDigest = calculateCommandPayloadDigest({ ...newer, activity: latestActivity });
      yield* sql`UPDATE orchestration_events SET payload_json = ${JSON.stringify({
        threadId,
        activity: latestActivity,
      })} WHERE command_id = ${newer.commandId}`;
      yield* sql`UPDATE orchestration_command_receipts SET payload_digest = ${latestDigest.digest}
        WHERE command_id = ${newer.commandId}`;
      yield* sql`DELETE FROM projection_thread_activities WHERE activity_id = ${newer.activity.id}`;
      const read = yield* makeLegacyMetadataEvidenceReader();
      const evidence = (yield* read({ threadId })).evidence;
      assert.isTrue(
        evidence.some((item) => item.commandId === newer.commandId && item.witness === "accepted"),
      );
      assert.isTrue(
        evidence.some(
          (item) => item.commandId === original.commandId && item.witness === "unknown",
        ),
      );
      const admit = yield* makeLegacyMetadataAdmission();
      assert.isFalse((yield* admit({ threadId, operation: "title" })).allowed);
    }),
  );
});
