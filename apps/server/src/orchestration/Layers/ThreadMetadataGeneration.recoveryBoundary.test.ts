import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { makeLegacyMetadataAdmission } from "../../persistence/Layers/ThreadMetadataGeneration.legacy.admission.ts";
import { seedThread } from "../../persistence/Layers/ThreadMetadataGeneration.legacy.test-helpers.ts";
import { captureLifecycleTest } from "./ThreadMetadataGeneration.capture.test-helpers.ts";

const operations = ["title", "summary"] as const;

const retainUnknownClaim = Effect.fn("retainUnknownClaim")(function* (at: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_command_receipt_claims
    (command_id, payload_digest_version, payload_digest, claimed_at)
    VALUES ('server:text-generation-status:recovery-boundary', 'unknown', 'retained', ${at})`;
});

describe("metadata explicit recovery boundary", () => {
  it.each(operations)(
    "retains the global orphan barrier for a newly created %s thread",
    (operation) =>
      captureLifecycleTest(operation, (f) =>
        Effect.gen(function* () {
          yield* retainUnknownClaim(f.now());
          const threadId = yield* seedThread(`created-after-orphan-${operation}`);
          const admit = yield* makeLegacyMetadataAdmission();
          expect(yield* admit({ threadId, operation })).toEqual({
            allowed: false,
            reason: "unknown-evidence",
          });
          expect(f.control.calls).toEqual([]);
        }),
      ),
  );

  it.each(
    operations.flatMap((operation) => [false, true].map((orphan) => ({ operation, orphan }))),
  )(
    "gives a distinct $operation retry a new budget without bypassing orphan=$orphan",
    ({ operation, orphan }) =>
      captureLifecycleTest(operation, (f) =>
        Effect.gen(function* () {
          yield* f.request();
          const original = yield* f.open;
          f.control.time = Date.parse(original.deadlineAt) + 1;
          yield* f.service.step(original.jobId);
          const settled = yield* f.read(original.jobId);
          expect(yield* f.repository.listAttempts(original.jobId)).toEqual([]);
          if (orphan) yield* retainUnknownClaim(f.now());

          yield* f.request("explicit-fresh-recovery");
          const fresh = yield* f.open;
          expect(fresh.jobId).not.toBe(original.jobId);
          expect(fresh.generationKey).not.toBe(original.generationKey);
          expect(Date.parse(fresh.deadlineAt)).toBeGreaterThan(Date.parse(original.deadlineAt));
          yield* f.request("explicit-fresh-recovery");
          expect((yield* f.open).jobId).toBe(fresh.jobId);
          expect(yield* f.jobs).toHaveLength(2);

          yield* f.service.step(fresh.jobId);
          yield* f.service.step(fresh.jobId);
          expect(yield* f.read(original.jobId)).toEqual(settled);
          expect(yield* f.repository.listAttempts(original.jobId)).toEqual([]);
          expect(f.control.calls).toEqual(orphan ? [] : ["model-a"]);
          const attempts = yield* f.repository.listAttempts(fresh.jobId);
          expect(attempts).toHaveLength(1);
          expect(attempts[0]?.state).toBe(orphan ? "unavailable" : "completed");
          if (orphan) {
            const sql = yield* SqlClient.SqlClient;
            expect(
              yield* sql`SELECT payload_digest FROM orchestration_command_receipt_claims
            WHERE command_id = 'server:text-generation-status:recovery-boundary'`,
            ).toEqual([{ payload_digest: "retained" }]);
          }
        }),
      ),
  );
});
