import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ThreadMetadataGenerationRepository } from "../../persistence/Services/ThreadMetadataGeneration.ts";
import {
  capturedTitle,
  coordinatorTestLayer,
  makeCoordinatorFixture,
} from "./ThreadMetadataGeneration.coordinator.test-helpers.ts";

it.layer(coordinatorTestLayer)("model-binding validation preserves uncertainty", (it) => {
  for (const fault of ["schema", "selection", "workspace", "bound-at"] as const) {
    it.effect(
      `rejects ${fault} corruption without releasing a potentially dispatched attempt`,
      () =>
        Effect.gen(function* () {
          const r = yield* ThreadMetadataGenerationRepository;
          const sql = yield* SqlClient.SqlClient;
          const f = makeCoordinatorFixture(r);
          const captured = capturedTitle();
          const path = captured.threadPath!;
          const job = yield* f.create({
            ...captured,
            configuredPrimary: false,
            primaryPath: null,
            threadPath: null,
          });
          const verifiedModelJson = JSON.stringify(path.selection);
          yield* r.recordSuccessfulModel(job.threadId, verifiedModelJson);
          assert.isTrue(
            yield* r.bindThreadModel({
              job,
              pathJson: JSON.stringify(path),
              verifiedModelJson,
              at: f.control.at,
            }),
          );
          f.control.outcome = "uncertain";
          yield* f.coordinator.step(job.jobId);
          const original = (yield* r.listAttempts(job.jobId))[0]!;
          assert.strictEqual(original.state, "uncertain");
          const originalJob = Option.getOrThrow(yield* r.get(job.jobId));
          // Simulate retained storage corruption, not an API for replacing immutable bindings.
          if (fault === "bound-at") {
            yield* sql`UPDATE thread_metadata_generation_model_bindings SET bound_at = ${job.modelWaitUntil} WHERE job_id = ${job.jobId}`;
          } else {
            const changed =
              fault === "schema"
                ? {}
                : fault === "selection"
                  ? { ...path, selection: { provider: "codex", model: "different" } }
                  : { ...path, executionTarget: "remote:other" };
            yield* sql`UPDATE thread_metadata_generation_model_bindings SET path_json = ${JSON.stringify(changed)} WHERE job_id = ${job.jobId}`;
          }
          assert.strictEqual(
            (yield* f.coordinator.step(job.jobId).pipe(Effect.result))._tag,
            "Failure",
          );
          assert.deepStrictEqual(Option.getOrThrow(yield* r.get(job.jobId)), originalJob);
          assert.deepStrictEqual(yield* r.listAttempts(job.jobId), [original]);
          f.advance(86_400_000);
          yield* f.coordinator.step(job.jobId).pipe(Effect.result);
          assert.deepStrictEqual(yield* r.listAttempts(job.jobId), [original]);
          assert.strictEqual(f.control.calls.length, 1);
        }),
    );
  }
});
