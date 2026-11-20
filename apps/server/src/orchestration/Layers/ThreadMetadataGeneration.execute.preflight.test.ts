import { TextGenerationError } from "@bigbud/contracts/workspace/git.errors.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { ThreadMetadataGenerationRepository } from "../../persistence/Services/ThreadMetadataGeneration.ts";
import { makeMetadataCoordinator } from "./ThreadMetadataGeneration.coordinator.ts";
import {
  coordinatorTestLayer,
  makeCoordinatorFixture,
} from "./ThreadMetadataGeneration.coordinator.test-helpers.ts";

it.layer(coordinatorTestLayer)("metadata auxiliary preflight settlement", (it) => {
  for (const mode of ["refused", "missing-claim", "competing-winner", "lost-response"] as const) {
    it.effect(`settles only definitive prepared refusals: ${mode}`, () =>
      Effect.gen(function* () {
        const repository = yield* ThreadMetadataGenerationRepository;
        const f = makeCoordinatorFixture(repository);
        f.control.outcome = "success";
        const job = yield* f.create();
        const coordinator = makeMetadataCoordinator({
          repository,
          textGeneration: f.textGeneration,
          host: {
            ...f.host,
            withDispatchAdmission: (_context, _path, claim) =>
              Effect.gen(function* () {
                if (mode === "missing-claim") return;
                if (mode === "competing-winner") {
                  const [prepared] = yield* repository.listAttempts(job.jobId);
                  assert.isTrue(yield* repository.claimDispatch(prepared!, f.control.at));
                }
                if (mode === "lost-response") {
                  yield* claim;
                  return yield* new PersistenceSqlError({
                    operation: "admission.commit",
                    detail: "Lost response",
                  });
                }
                return yield* new TextGenerationError({
                  operation: "generateThreadTitle",
                  detail: "Admission refused",
                  metadataOutcome: "unavailable",
                });
              }),
          },
        });
        yield* coordinator.step(job.jobId);
        const [attempt] = yield* repository.listAttempts(job.jobId);
        assert.strictEqual(
          attempt?.state,
          mode === "competing-winner"
            ? "dispatch-intent"
            : mode === "lost-response"
              ? "uncertain"
              : "unavailable",
        );
        assert.strictEqual(f.control.calls.length, 0);
        assert.strictEqual((yield* repository.listPendingWarnings(100)).length, 0);
        if (mode === "competing-winner" || mode === "lost-response") {
          f.advance(86_400_000);
          yield* coordinator.step(job.jobId);
          assert.strictEqual(f.control.calls.length, 0);
          assert.strictEqual((yield* repository.listAttempts(job.jobId)).length, 1);
        }
      }),
    );
  }
});
