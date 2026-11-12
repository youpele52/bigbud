import { EventId } from "@bigbud/contracts/core/baseSchemas.ts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { readTextGenerationRequest } from "../../git/Layers/InternalTextGeneration.requests.ts";
import { makeLegacyMetadataAdmission } from "../../persistence/Layers/ThreadMetadataGeneration.legacy.admission.ts";
import { requestTextGenerationRetry } from "../../ws/wsRetryTextGeneration.ts";
import {
  captureLifecycleTest,
  captureThreadId,
} from "./ThreadMetadataGeneration.capture.test-helpers.ts";

const operations = ["title", "summary"] as const;
const acknowledgement = "authorize-new-budget-with-unresolved-history" as const;

const orphan = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_command_receipt_claims
    (command_id, payload_digest_version, payload_digest, claimed_at)
    VALUES ('server:text-generation-status:old', 'unknown', 'preserved', '2099-01-01T00:00:00.000Z')`;
});

const queue = (
  f: Parameters<Parameters<typeof captureLifecycleTest>[1]>[0],
  operation: "title" | "summary",
  identity = "explicit-authorization",
) =>
  requestTextGenerationRetry(
    f.engine,
    {
      threadId: captureThreadId,
      operation,
      newRequestId: EventId.makeUnsafe(identity),
      acknowledgeHistoricalUncertainty: acknowledgement,
    },
    f.settings,
  );

const recoveryId = "text-generation-recovery:explicit-authorization";
const capture = (
  f: Parameters<Parameters<typeof captureLifecycleTest>[1]>[0],
  operation: "title" | "summary",
  retryKey = recoveryId,
) => {
  const identity = { threadId: captureThreadId, retryKey, legacyRecoveryRequestId: recoveryId };
  return operation === "title"
    ? f.service.title({ ...identity, messageText: "Repair durable capture lifecycle" })
    : f.service.summary({ ...identity, force: true });
};

describe("explicit new metadata budget", () => {
  it.each(operations)(
    "dispatches %s once with exact accepted consent despite clock skew",
    (operation) =>
      captureLifecycleTest(operation, (f) =>
        Effect.gen(function* () {
          yield* orphan;
          const sql = yield* SqlClient.SqlClient;
          const before = yield* sql`SELECT * FROM orchestration_command_receipt_claims
        WHERE command_id = 'server:text-generation-status:old'`;
          yield* queue(f, operation);
          yield* queue(f, operation);
          const thread = (yield* f.engine.getReadModel()).threads.find(
            (item) => item.id === captureThreadId,
          )!;
          const requests = thread.activities.filter((item) => readTextGenerationRequest(item));
          expect(requests).toHaveLength(1);
          expect(readTextGenerationRequest(requests[0]!)?.legacyRecovery?.claims).toHaveLength(1);
          const admit = yield* makeLegacyMetadataAdmission();
          expect((yield* admit({ threadId: captureThreadId, operation })).allowed).toBe(false);
          yield* capture(f, operation);
          const job = yield* f.open;
          yield* capture(f, operation);
          expect((yield* f.open).deadlineAt).toBe(job.deadlineAt);
          yield* f.service.step(job.jobId);
          yield* f.service.step(job.jobId);
          const restarted = yield* f.compose();
          yield* restarted.step(job.jobId);
          expect(f.control.calls).toEqual(["model-a"]);
          expect(yield* f.jobs).toHaveLength(1);
          expect((yield* f.repository.listAttempts(job.jobId))[0]?.state).toBe("completed");
          expect(
            yield* sql`SELECT * FROM orchestration_command_receipt_claims
        WHERE command_id = 'server:text-generation-status:old'`,
          ).toEqual(before);
        }),
      ),
  );

  it.each(["dispatch-intent", "acknowledged", "uncertain", "result-ready"] as const)(
    "consent never clears an existing %s reservation",
    (state) =>
      captureLifecycleTest("title", (f) =>
        Effect.gen(function* () {
          yield* orphan;
          yield* queue(f, "title");
          yield* f.request();
          const original = yield* f.open;
          const prepared = yield* f.prepare(original);
          expect(yield* f.repository.claimDispatch(prepared, f.now())).toBe(true);
          if (state !== "dispatch-intent") {
            const attempt = (yield* f.repository.listAttempts(original.jobId))[0]!;
            expect(
              yield* f.repository.settleAttempt({
                attempt,
                state,
                at: f.now(),
                ...(state === "result-ready" ? { result: "Retained output" } : {}),
              }),
            ).toBe(true);
          }
          const before = yield* f.repository.listAttempts(original.jobId);
          expect((yield* capture(f, "title").pipe(Effect.result))._tag).toBe("Failure");
          expect(yield* f.repository.listAttempts(original.jobId)).toEqual(before);
          expect(yield* f.jobs).toHaveLength(1);
          expect(f.control.calls).toEqual([]);
        }),
      ),
  );

  it("reports an active request without accepting a second authorization", () =>
    captureLifecycleTest("title", (f) =>
      Effect.gen(function* () {
        yield* orphan;
        yield* queue(f, "title");
        const result = yield* queue(f, "title", "second-authorization").pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        const thread = (yield* f.engine.getReadModel()).threads.find(
          (item) => item.id === captureThreadId,
        )!;
        expect(thread.activities.filter((item) => readTextGenerationRequest(item))).toHaveLength(1);
        expect(f.control.calls).toEqual([]);
      }),
    ));

  it("refuses snapshots above the claim limit without accepting a request", () =>
    captureLifecycleTest("title", (f) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (let index = 0; index < 33; index++)
          yield* sql`INSERT INTO orchestration_command_receipt_claims
            (command_id, payload_digest_version, payload_digest, claimed_at)
            VALUES (${`server:text-generation-status:overflow-${index}`}, 'unknown', 'retained', '2099-01-01T00:00:00.000Z')`;
        const before =
          yield* sql`SELECT * FROM orchestration_command_receipt_claims ORDER BY command_id`;
        expect((yield* queue(f, "title").pipe(Effect.result))._tag).toBe("Failure");
        expect(
          yield* sql`SELECT * FROM orchestration_command_receipt_claims ORDER BY command_id`,
        ).toEqual(before);
        const thread = (yield* f.engine.getReadModel()).threads.find(
          (item) => item.id === captureThreadId,
        )!;
        expect(thread.activities.filter((item) => readTextGenerationRequest(item))).toHaveLength(0);
        expect(yield* f.jobs).toHaveLength(0);
        expect(f.control.calls).toEqual([]);
      }),
    ));

  it("cannot reuse consent with a different budget identity", () =>
    captureLifecycleTest("title", (f) =>
      Effect.gen(function* () {
        yield* orphan;
        yield* queue(f, "title");
        expect((yield* capture(f, "title", "different-request").pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(yield* f.jobs).toHaveLength(0);
        expect(f.control.calls).toEqual([]);
      }),
    ));

  it.each([
    "new-claim",
    "changed-digest",
    "changed-time",
    "missing-receipt",
    "missing-event",
    "missing-projection",
    "bad-digest",
    "wrong-operation",
    "wrong-owner",
    "known-work",
  ] as const)("blocks %s after consent without dispatch", (change) =>
    captureLifecycleTest("title", (f) =>
      Effect.gen(function* () {
        yield* orphan;
        yield* queue(f, "title");
        const sql = yield* SqlClient.SqlClient;
        if (change === "new-claim")
          yield* sql`INSERT INTO orchestration_command_receipt_claims
        (command_id, payload_digest_version, payload_digest, claimed_at)
        VALUES ('server:text-generation-status:later', 'unknown', 'later', '1900-01-01T00:00:00.000Z')`;
        if (change === "changed-digest")
          yield* sql`UPDATE orchestration_command_receipt_claims SET payload_digest = 'changed'
        WHERE command_id = 'server:text-generation-status:old'`;
        if (change === "changed-time")
          yield* sql`UPDATE orchestration_command_receipt_claims SET claimed_at = '1900-01-01T00:00:00.000Z'
        WHERE command_id = 'server:text-generation-status:old'`;
        if (change === "missing-receipt")
          yield* sql`DELETE FROM orchestration_command_receipts WHERE command_id = ${`server:${recoveryId}`}`;
        if (change === "missing-event")
          yield* sql`DELETE FROM orchestration_events WHERE command_id = ${`server:${recoveryId}`}`;
        if (change === "missing-projection")
          yield* sql`DELETE FROM projection_thread_activities WHERE activity_id = ${recoveryId}`;
        if (change === "bad-digest")
          yield* sql`UPDATE orchestration_command_receipts SET payload_digest = 'forged' WHERE command_id = ${`server:${recoveryId}`}`;
        if (change === "wrong-owner")
          yield* sql`UPDATE orchestration_command_receipts SET aggregate_id = 'other-thread' WHERE command_id = ${`server:${recoveryId}`}`;
        if (change === "known-work")
          yield* sql`INSERT INTO orchestration_command_receipt_claims
        (command_id, payload_digest_version, payload_digest, claimed_at)
        VALUES (${`server:text-generation-title-stage:${captureThreadId}:1:started`}, 'unknown', 'retained', '1900-01-01T00:00:00.000Z')`;
        const admit = yield* makeLegacyMetadataAdmission();
        expect(
          (yield* admit({
            threadId: captureThreadId,
            operation: change === "wrong-operation" ? "summary" : "title",
            legacyRecoveryRequestId: recoveryId,
          })).allowed,
        ).toBe(false);
        if (change !== "wrong-operation") {
          yield* capture(f, "title");
          const job = yield* f.open;
          yield* f.service.step(job.jobId);
          expect((yield* f.repository.listAttempts(job.jobId))[0]?.state).toBe("unavailable");
        }
        expect(f.control.calls).toEqual([]);
      }),
    ),
  );
});
