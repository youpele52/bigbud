import * as Effect from "effect/Effect";
import { afterEach, beforeEach, vi } from "vitest";
import * as metadata from "./ThreadMetadataGeneration.ts";
import { capturedTitle } from "./ThreadMetadataGeneration.coordinator.test-helpers.ts";
import { createHarness, waitFor } from "./ProviderCommandReactor.test.helpers.ts";

type Harness = Awaited<ReturnType<typeof createHarness>>;
const compose = metadata.makeThreadMetadataGeneration;

/** Real scheduler, coordinator, SQL admission and canonical commit; only external provider authority is synthetic. */
export function useTitleMetadataFixture() {
  beforeEach(() => {
    vi.spyOn(metadata, "makeThreadMetadataGeneration").mockImplementation((input) =>
      compose({
        ...input,
        executionIdentity: {
          capture: (selection, executionTarget) =>
            Effect.succeed({ ...capturedTitle().primaryPath!, selection, executionTarget }),
          providerSettings: () =>
            input.settings.getSettings.pipe(
              Effect.map((settings) => settings.providers),
              Effect.orDie,
            ),
          withExecutionIdentity: (_context, _path, _snapshot, claim) => claim,
        },
        textGeneration: {
          ...input.textGeneration,
          generateThreadTitle: (request) => {
            if (!request.metadataAttempt)
              return Effect.die("Missing exact metadata dispatch attempt");
            return request.metadataAttempt
              .beforeDispatch()
              .pipe(
                Effect.andThen(
                  Effect.suspend(() => input.textGeneration.generateThreadTitle(request)),
                ),
              );
          },
        },
      }),
    );
  });
  afterEach(() => vi.restoreAllMocks());
}

/** Two-second polling plus the persisted two-second retry can exceed the generic two-second helper. */
export const waitForMetadata = (predicate: () => boolean | Promise<boolean>) =>
  waitFor(predicate, 10_000);

export const readTitleJobs = (harness: Harness) =>
  Effect.runPromise(harness.sql<{
    jobId: string;
    state: string;
  }>`SELECT job_id AS "jobId", state FROM thread_metadata_generation_jobs
  WHERE thread_id = 'thread-1' AND operation = 'title' ORDER BY created_at, job_id`);

export const readTitleAttempts = (harness: Harness) =>
  Effect.runPromise(harness.sql<{
    stage: string;
    state: string;
    ordinal: number;
  }>`SELECT a.stage, a.state, a.ordinal FROM thread_metadata_generation_attempts a
  JOIN thread_metadata_generation_jobs j ON j.job_id = a.job_id
  WHERE j.thread_id = 'thread-1' AND j.operation = 'title' ORDER BY a.created_at, a.ordinal`);
