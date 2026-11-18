import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ThreadMetadataGenerationRepository } from "../Services/ThreadMetadataGeneration.ts";
import {
  capturedTitle,
  coordinatorTestLayer,
  makeCoordinatorFixture,
} from "../../orchestration/Layers/ThreadMetadataGeneration.coordinator.test-helpers.ts";

it.layer(coordinatorTestLayer)("immutable metadata model bindings", (it) => {
  it.effect("CAS-selects one path, fences stale job revisions and never replaces the binding", () =>
    Effect.gen(function* () {
      const r = yield* ThreadMetadataGenerationRepository;
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
      const input = { job, pathJson: JSON.stringify(path), verifiedModelJson, at: f.control.at };
      const results = yield* Effect.all(
        [
          r.bindThreadModel(input),
          r.bindThreadModel({
            ...input,
            pathJson: JSON.stringify({ ...path, accountIdentity: "other" }),
          }),
        ],
        { concurrency: 2 },
      );
      assert.strictEqual(results.filter(Boolean).length, 1);
      const binding = Option.getOrThrow(yield* r.readThreadModelBinding(job.jobId));
      const current = Option.getOrThrow(yield* r.get(job.jobId));
      assert.strictEqual(current.revision, job.revision + 1);
      assert.strictEqual(current.contextJson, job.contextJson);
      assert.isFalse(yield* r.bindThreadModel({ ...input, job: current }));
      assert.deepStrictEqual(
        Option.getOrThrow(yield* r.readThreadModelBinding(job.jobId)),
        binding,
      );
      assert.isFalse(
        yield* r.transitionJob({
          jobId: job.jobId,
          expectedRevision: job.revision,
          state: "cancelled",
          nextAttemptAt: f.control.at,
        }),
      );
    }),
  );

  for (const fault of [
    "missing-proof",
    "changed-proof",
    "deadline",
    "captured-path",
    "terminal",
    "uncertain",
  ] as const) {
    it.effect(`refuses binding with ${fault}`, () =>
      Effect.gen(function* () {
        const r = yield* ThreadMetadataGenerationRepository;
        const f = makeCoordinatorFixture(r);
        const captured = capturedTitle();
        const path = captured.threadPath!;
        const job = yield* f.create({
          ...captured,
          configuredPrimary: fault === "uncertain",
          primaryPath: fault === "uncertain" ? captured.primaryPath : null,
          threadPath: fault === "captured-path" ? path : null,
        });
        const verifiedModelJson = JSON.stringify(path.selection);
        if (fault !== "missing-proof")
          yield* r.recordSuccessfulModel(
            job.threadId,
            fault === "changed-proof"
              ? JSON.stringify({ provider: "codex", model: "different" })
              : verifiedModelJson,
          );
        if (fault === "terminal")
          yield* r.transitionJob({
            jobId: job.jobId,
            expectedRevision: job.revision,
            state: "cancelled",
            nextAttemptAt: f.control.at,
          });
        if (fault === "uncertain") {
          f.control.outcome = "uncertain";
          yield* f.coordinator.step(job.jobId);
          assert.strictEqual((yield* r.listAttempts(job.jobId))[0]?.state, "uncertain");
        }
        assert.isFalse(
          yield* r.bindThreadModel({
            job,
            pathJson: JSON.stringify(path),
            verifiedModelJson,
            at: fault === "deadline" ? job.deadlineAt : f.control.at,
          }),
        );
        assert.isTrue(Option.isNone(yield* r.readThreadModelBinding(job.jobId)));
      }),
    );
  }
});
