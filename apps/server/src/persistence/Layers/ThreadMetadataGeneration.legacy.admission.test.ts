import { EventId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import {
  makeLegacyMetadataAdmission,
  scanLegacyMetadataAdmission,
} from "./ThreadMetadataGeneration.legacy.admission.ts";
import type { LegacyMetadataEvidence } from "./ThreadMetadataGeneration.legacy.ts";
import { at, seedActivity, seedThread } from "./ThreadMetadataGeneration.legacy.test-helpers.ts";

it.layer(SqlitePersistenceMemory)("legacy metadata admission", (it) => {
  it.effect("admits new work and recovers the last verified model by event sequence", () =>
    Effect.gen(function* () {
      const threadId = yield* seedThread("legacy-admission-model");
      const admit = yield* makeLegacyMetadataAdmission();
      assert.deepStrictEqual(yield* admit({ threadId, operation: "title" }), {
        allowed: true,
        successfulModel: null,
      });
      yield* seedActivity(threadId, "z-old", "text-generation.model-succeeded", {
        provider: "codex",
        model: "older",
      });
      yield* seedActivity(threadId, "a-new", "text-generation.model-succeeded", {
        provider: "claudeAgent",
        model: "newer",
        options: { effort: "high" },
      });
      assert.deepStrictEqual(yield* admit({ threadId, operation: "summary" }), {
        allowed: true,
        successfulModel: {
          provider: "claudeAgent",
          model: "newer",
          options: { effort: "high" },
        },
      });
    }),
  );

  for (const kind of ["started", "uncertain", "failed", "completed"] as const) {
    it.effect(`does not use an accepted ${kind} status as provider-terminal proof`, () =>
      Effect.gen(function* () {
        const threadId = yield* seedThread(`legacy-admission-${kind}`);
        yield* seedActivity(threadId, `status-${kind}`, `text-generation.${kind}`, {
          operation: "summary",
          uncertaintyProtected: true,
          uncertaintyId: "native-work",
        });
        yield* seedActivity(threadId, `later-${kind}`, "text-generation.completed", {
          operation: "summary",
        });
        const admit = yield* makeLegacyMetadataAdmission();
        assert.deepStrictEqual(yield* admit({ threadId, operation: "summary" }), {
          allowed: false,
          reason: "legacy-paid-work",
        });
        assert.isTrue((yield* admit({ threadId, operation: "title" })).allowed);
      }),
    );
  }

  it.effect("does not clear a deterministic legacy title claim with a status settlement", () =>
    Effect.gen(function* () {
      const threadId = yield* seedThread("legacy-admission-title");
      yield* seedActivity(threadId, `text-generation-title-stage:${threadId}:1:started`);
      yield* seedActivity(
        threadId,
        `text-generation-title-stage:${threadId}:1:completed`,
        "text-generation.title-stage",
        { stage: 1, state: "completed" },
      );
      const admit = yield* makeLegacyMetadataAdmission();
      assert.isFalse((yield* admit({ threadId, operation: "title" })).allowed);
      assert.isTrue((yield* admit({ threadId, operation: "summary" })).allowed);
    }),
  );

  it.effect("request-settled bookkeeping never clears an explicit request owner", () =>
    Effect.gen(function* () {
      const threadId = yield* seedThread("legacy-admission-request");
      yield* seedActivity(threadId, "request", "text-generation.retry-requested", {
        operation: "title",
      });
      yield* seedActivity(threadId, "request-started", "text-generation.request-started", {
        requestId: "request",
        owner: "original-owner",
      });
      yield* seedActivity(threadId, "request-settled", "text-generation.request-settled", {
        requestId: "request",
      });
      const admit = yield* makeLegacyMetadataAdmission();
      for (const operation of ["title", "summary"] as const)
        assert.isFalse((yield* admit({ threadId, operation })).allowed);
    }),
  );

  it.effect("cannot hide a claim behind the runtime activity tail or later bookkeeping", () =>
    Effect.gen(function* () {
      const threadId = yield* seedThread("legacy-admission-tail");
      yield* seedActivity(threadId, "z-claim", "text-generation.started", {
        operation: "title",
      });
      for (let index = 0; index < 501; index += 1)
        yield* seedActivity(threadId, `a-${index}`, "text-generation.deferred", {
          operation: "title",
        });
      const admit = yield* makeLegacyMetadataAdmission();
      assert.isFalse((yield* admit({ threadId, operation: "title" })).allowed);
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(
        yield* sql`SELECT COUNT(*) AS count FROM orchestration_command_receipts WHERE aggregate_id = ${threadId}`,
        [{ count: 502 }],
      );
    }),
  );

  it.effect("fails closed for unverified records without rewriting their receipts", () =>
    Effect.gen(function* () {
      const threadId = yield* seedThread("legacy-admission-digest");
      const command = yield* seedActivity(threadId, "model", "text-generation.model-succeeded", {
        provider: "codex",
        model: "unverified",
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_command_receipts SET payload_digest_version = 'unknown' WHERE command_id = ${command.commandId}`;
      const before = yield* sql`SELECT * FROM orchestration_command_receipts`;
      const admit = yield* makeLegacyMetadataAdmission();
      assert.deepStrictEqual(yield* admit({ threadId, operation: "title" }), {
        allowed: false,
        reason: "unknown-evidence",
      });
      assert.deepStrictEqual(yield* sql`SELECT * FROM orchestration_command_receipts`, before);
    }),
  );

  it.effect("retains request dispatch claims and unattributable status claims", () =>
    Effect.gen(function* () {
      const threadId = yield* seedThread("legacy-admission-orphans");
      const other = yield* seedThread("legacy-admission-other");
      yield* seedActivity(threadId, "orphan-request", "text-generation.retry-requested", {
        operation: "title",
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_command_receipt_claims
        (command_id, payload_digest_version, payload_digest, claimed_at)
        VALUES ('server:text-generation-request-started:orphan-request', 'unknown', 'original', ${at})`;
      const admit = yield* makeLegacyMetadataAdmission();
      assert.isFalse((yield* admit({ threadId, operation: "title" })).allowed);
      assert.isTrue((yield* admit({ threadId: other, operation: "title" })).allowed);
      // No payload or thread identity survives in this claim. It cannot safely be assigned
      // to another thread or declared undispatched, even though no accepted receipt exists.
      yield* sql`INSERT INTO orchestration_command_receipt_claims
        (command_id, payload_digest_version, payload_digest, claimed_at)
        VALUES ('server:text-generation-status:orphan', 'unknown', 'original', ${at})`;
      assert.isFalse((yield* admit({ threadId: other, operation: "summary" })).allowed);
    }),
  );

  it.effect("retains canonical activity events when both projection and receipt are absent", () =>
    Effect.gen(function* () {
      const threadId = yield* seedThread("legacy-admission-event");
      yield* seedActivity(
        threadId,
        "orphan-event",
        "text-generation.started",
        {
          operation: "title",
        },
        false,
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM projection_thread_activities WHERE activity_id = 'orphan-event'`;
      const admit = yield* makeLegacyMetadataAdmission();
      assert.isFalse((yield* admit({ threadId, operation: "title" })).allowed);
    }),
  );
});

const threadId = ThreadId.makeUnsafe("bounded-scan");
const modelEvidence: LegacyMetadataEvidence = {
  key: "model",
  commandId: "model-command",
  witness: "accepted",
  sequence: 1,
  activity: {
    id: EventId.makeUnsafe("model"),
    kind: "text-generation.model-succeeded",
    tone: "info",
    summary: "Successful model",
    turnId: null,
    createdAt: at,
    payload: { provider: "codex", model: "verified" },
  },
};

it.effect("bounds page work and refuses a stalled or regressing cursor", () =>
  Effect.gen(function* () {
    for (const mode of ["unending", "stalled", "regressing"] as const) {
      let calls = 0;
      const result = yield* scanLegacyMetadataAdmission(
        () =>
          Effect.sync(() => ({
            evidence: [modelEvidence],
            nextKey:
              mode === "unending"
                ? String(++calls).padStart(6, "0")
                : mode === "stalled"
                  ? "same"
                  : ++calls === 1
                    ? "z"
                    : "a",
          })),
        { threadId, operation: "title" },
      );
      assert.deepStrictEqual(result, { allowed: false, reason: "scan-limit" });
      if (mode === "unending") assert.strictEqual(calls, 100);
    }
  }),
);

it.effect("propagates SQL failures rather than treating unread history as clear", () =>
  Effect.gen(function* () {
    const error = toPersistenceSqlError("legacy-admission-test")(new Error("storage unavailable"));
    const result = yield* scanLegacyMetadataAdmission(() => Effect.fail(error), {
      threadId,
      operation: "title",
    }).pipe(Effect.result);
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") assert.strictEqual(result.failure, error);
  }),
);
