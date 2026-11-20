import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { seedActivity } from "../../persistence/Layers/ThreadMetadataGeneration.legacy.test-helpers.ts";
import {
  captureLifecycleTest,
  captureThreadId,
} from "./ThreadMetadataGeneration.capture.test-helpers.ts";
import { decodeMetadataContext } from "./ThreadMetadataGeneration.context.ts";
import { loadMetadataContext } from "./ThreadMetadataGeneration.modelBinding.ts";

const selection = { provider: "codex", model: "historically-verified" } as const;

for (const operation of ["title", "summary"] as const) {
  describe(`${operation} historical successful model recovery`, () => {
    for (const configured of [true, false]) {
      it(`captures historical proof without a new turn (configured override: ${configured})`, () =>
        captureLifecycleTest(operation, (f) =>
          Effect.gen(function* () {
            if (!configured)
              yield* f.settings.updateSettings({ textGenerationModelSelection: null });
            const sql = yield* SqlClient.SqlClient;
            yield* seedActivity(
              captureThreadId,
              "historical-capture",
              "text-generation.model-succeeded",
              selection,
            );
            expect(
              yield* sql`SELECT successful_model_json FROM thread_metadata_generation_state WHERE thread_id = ${captureThreadId}`,
            ).toEqual([]);
            yield* f.request();
            const job = yield* f.open;
            const context = yield* decodeMetadataContext(job.contextJson);
            expect(context.threadPath?.selection).toEqual(selection);
            if (configured) expect(context.primaryPath?.selection.model).toBe("model-a");
            else expect(context.primaryPath).toBeNull();
            expect(context.threadPath?.executionTarget).toBe(context.workspace.executionTarget);
            expect(context.threadPath?.accountIdentity).toBeDefined();
            if (configured)
              expect(context.threadPath?.accountIdentity).toBe(
                context.primaryPath?.accountIdentity,
              );
            expect(f.control.calls).toEqual([]);
            expect(yield* f.repository.listAttempts(job.jobId)).toEqual([]);
            yield* f.request();
            expect((yield* f.open).jobId).toBe(job.jobId);
            expect(yield* f.jobs).toHaveLength(1);
          }),
        ));

      it(`late-binds a pathless job from legacy SQL without extending budgets (override: ${configured})`, () =>
        captureLifecycleTest(operation, (f) =>
          Effect.gen(function* () {
            if (!configured)
              yield* f.settings.updateSettings({ textGenerationModelSelection: null });
            yield* f.request();
            const original = yield* f.open;
            expect((yield* decodeMetadataContext(original.contextJson)).threadPath).toBeNull();
            // Simulate an upgraded durable job predating state initialization. This writes
            // canonical historical fixtures only, not the new successful-model hook.
            yield* seedActivity(
              captureThreadId,
              "historical-binding",
              "text-generation.model-succeeded",
              selection,
            );
            f.control.time += 1_000;
            const resumed = yield* f.compose();
            yield* resumed.step(original.jobId);
            const bound = yield* f.read(original.jobId);
            const context = yield* loadMetadataContext(f.repository, bound);
            expect(context.threadPath?.selection).toEqual(selection);
            if (configured) expect(context.primaryPath?.selection.model).toBe("model-a");
            else expect(context.primaryPath).toBeNull();
            expect(bound.contextJson).toBe(original.contextJson);
            expect(bound.revision).toBe(original.revision + 1);
            for (const field of [
              "deadlineAt",
              "modelWaitUntil",
              "nativeWaitUntil",
              "createdAt",
            ] as const)
              expect(bound[field]).toBe(original[field]);
            expect(yield* f.repository.listAttempts(original.jobId)).toEqual([]);
            expect(f.control.calls).toEqual([]);
            const binding = Option.getOrThrow(
              yield* f.repository.readThreadModelBinding(original.jobId),
            );
            yield* f.repository.recordSuccessfulModel(
              captureThreadId,
              JSON.stringify({ provider: "codex", model: "newer" }),
            );
            const retained = yield* loadMetadataContext(f.repository, bound);
            expect(retained).toEqual(context);
            expect(
              Option.getOrThrow(yield* f.repository.readThreadModelBinding(original.jobId)),
            ).toEqual(binding);
          }),
        ));
    }
  });
}
