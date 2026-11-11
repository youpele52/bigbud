import { EventId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { makeLegacyMetadataEvidenceReader } from "./ThreadMetadataGeneration.legacy.ts";
import { at, seedActivity, seedThread } from "./ThreadMetadataGeneration.legacy.test-helpers.ts";

it.layer(SqlitePersistenceMemory)("authoritative legacy metadata evidence", (it) => {
  it.effect("accepts the projector sequence on user bindings but rejects altered evidence", () =>
    Effect.gen(function* () {
      const threadId = yield* seedThread("binding-sequence");
      const command = yield* seedActivity(threadId, "binding", "text-generation.user-turn-bound", {
        messageId: "first-user-message",
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_thread_activities SET sequence = (
        SELECT result_sequence FROM orchestration_command_receipts
        WHERE command_id = ${command.commandId}
      ) WHERE activity_id = 'binding'`;
      const read = yield* makeLegacyMetadataEvidenceReader();
      assert.equal((yield* read({ threadId })).evidence[0]?.witness, "accepted");
      yield* sql`UPDATE projection_thread_activities SET sequence = sequence + 1
        WHERE activity_id = 'binding'`;
      assert.equal((yield* read({ threadId })).evidence[0]?.witness, "unknown");
      yield* sql`UPDATE projection_thread_activities SET sequence = sequence - 1,
        summary = 'altered' WHERE activity_id = 'binding'`;
      assert.equal((yield* read({ threadId })).evidence[0]?.witness, "unknown");
    }),
  );

  it.effect("finds accepted claims and settlements beyond 500 unrelated activities", () =>
    Effect.gen(function* () {
      const threadId = yield* seedThread("legacy-tail");
      const started = `text-generation-title-stage:${threadId}:1:started`;
      const completed = `text-generation-title-stage:${threadId}:1:completed`;
      yield* seedActivity(threadId, started);
      yield* seedActivity(threadId, completed, "text-generation.title-stage", {
        stage: 1,
        state: "completed",
      });
      for (let index = 0; index < 501; index += 1)
        yield* seedActivity(threadId, `unrelated:${threadId}:${index}`, "runtime.progress");
      const read = yield* makeLegacyMetadataEvidenceReader();
      const page = yield* read({ threadId });
      assert.deepEqual(
        new Set(page.evidence.map((e) => e.activity?.id)),
        new Set([EventId.makeUnsafe(started), EventId.makeUnsafe(completed)]),
      );
      assert.isTrue(page.evidence.every((e) => e.witness === "accepted"));
      assert.isNull(page.nextKey);
      const recovered = yield* makeLegacyMetadataEvidenceReader();
      assert.deepEqual(yield* recovered({ threadId }), page);
    }),
  );

  it.effect("uses bounded keyset pages without dropping or duplicating metadata history", () =>
    Effect.gen(function* () {
      const threadId = yield* seedThread("legacy-pages");
      for (let index = 0; index < 205; index += 1)
        yield* seedActivity(
          threadId,
          `text-generation-status:${threadId}:${String(index).padStart(3, "0")}`,
        );
      const read = yield* makeLegacyMetadataEvidenceReader();
      const first = yield* read({ threadId });
      const second = yield* read({ threadId, afterKey: first.nextKey! });
      const third = yield* read({ threadId, afterKey: second.nextKey! });
      assert.deepEqual(
        [first.evidence.length, second.evidence.length, third.evidence.length],
        [100, 100, 5],
      );
      assert.equal(
        new Set([...first.evidence, ...second.evidence, ...third.evidence].map((e) => e.key)).size,
        205,
      );
      assert.isNull(third.nextKey);
    }),
  );

  it.effect("never upgrades mismatched, missing, malformed or legacy receipt evidence", () =>
    Effect.gen(function* () {
      const threadId = yield* seedThread("legacy-unverified");
      const sql = yield* SqlClient.SqlClient;
      for (const fault of [
        "digest",
        "version",
        "missing",
        "aggregate",
        "sequence",
        "rejected",
        "json",
        "legacy",
      ] as const) {
        const id = `text-generation-status:${threadId}:${fault}`;
        const command = yield* seedActivity(
          threadId,
          id,
          undefined,
          undefined,
          fault !== "missing",
        );
        if (fault === "missing") continue;
        if (fault === "json")
          yield* sql`UPDATE projection_thread_activities SET payload_json = '{broken' WHERE activity_id = ${id}`;
        else if (fault === "digest")
          yield* sql`UPDATE orchestration_command_receipts SET payload_digest = 'different' WHERE command_id = ${command.commandId}`;
        else if (fault === "version")
          yield* sql`UPDATE orchestration_command_receipts SET payload_digest_version = 'future' WHERE command_id = ${command.commandId}`;
        else if (fault === "aggregate")
          yield* sql`UPDATE orchestration_command_receipts SET aggregate_id = 'other-thread' WHERE command_id = ${command.commandId}`;
        else if (fault === "sequence")
          yield* sql`UPDATE orchestration_command_receipts SET result_sequence = result_sequence + 1 WHERE command_id = ${command.commandId}`;
        else if (fault === "rejected")
          yield* sql`UPDATE orchestration_command_receipts SET status = 'rejected' WHERE command_id = ${command.commandId}`;
        else
          yield* sql`UPDATE orchestration_command_receipts SET payload_digest = NULL, payload_digest_version = NULL WHERE command_id = ${command.commandId}`;
      }
      const read = yield* makeLegacyMetadataEvidenceReader();
      const page = yield* read({ threadId });
      assert.equal(page.evidence.length, 8);
      assert.isTrue(page.evidence.every((e) => e.witness === "unknown"));
      assert.equal(page.evidence.filter((e) => e.activity === null).length, 1);
    }),
  );

  it.effect(
    "retains orphan receipts and deterministic claims without touching stored evidence",
    () =>
      Effect.gen(function* () {
        const threadId = yield* seedThread("legacy-orphans");
        const sql = yield* SqlClient.SqlClient;
        const id = `text-generation-title-stage:${threadId}:1:started`;
        const command = yield* seedActivity(threadId, id);
        yield* sql`DELETE FROM projection_thread_activities WHERE activity_id = ${id}`;
        const claim = `server:text-generation-title-stage:${threadId}:2:started`;
        yield* sql`INSERT INTO orchestration_command_receipt_claims (
        command_id, payload_digest_version, payload_digest, claimed_at
      ) VALUES (${claim}, 'retained-version', 'retained-digest', ${at})`;
        const read = yield* makeLegacyMetadataEvidenceReader();
        const page = yield* read({ threadId });
        assert.deepEqual(
          new Set(page.evidence.map((e) => e.commandId)),
          new Set([command.commandId, claim]),
        );
        assert.isTrue(page.evidence.every((e) => e.witness === "unknown" && e.activity === null));
        const otherThread = yield* seedThread("legacy-isolation");
        assert.deepEqual((yield* read({ threadId: otherThread })).evidence, []);
        assert.deepEqual(
          yield* sql`SELECT payload_digest AS digest FROM orchestration_command_receipt_claims WHERE command_id = ${claim}`,
          [{ digest: "retained-digest" }],
        );
        assert.equal(
          (yield* sql`SELECT status FROM orchestration_command_receipts WHERE command_id = ${command.commandId}`)[0]
            ?.status,
          "accepted",
        );
      }),
  );
});
