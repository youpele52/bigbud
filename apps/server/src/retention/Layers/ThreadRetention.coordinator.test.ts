import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type {
  ThreadRetentionCandidate,
  ThreadRetentionRun,
} from "../../persistence/Services/ThreadRetentionRepository.ts";
import { retentionRun } from "./ThreadRetention.direct.test.helpers.ts";
import { makeThreadRetentionExecutionCoordinator } from "./ThreadRetention.coordinator.ts";

function makeCoordinatorRepository(initial: ReadonlyArray<ThreadRetentionRun>) {
  const runs = new Map(initial.map((run) => [run.runId, run]));
  let activeRunId = initial.find((run) => run.status !== "queued")?.runId;
  const executionOrder: string[] = [];
  let concurrent = 0;
  let maximumConcurrent = 0;
  let selectPage = (
    _runId: string | undefined,
  ): Effect.Effect<ReadonlyArray<ThreadRetentionCandidate>> =>
    Effect.sleep("10 millis").pipe(Effect.as([]));

  const repository = {
    getRun: (runId: string) => Effect.succeed(Option.fromNullishOr(runs.get(runId))),
    listRecoverableRuns: () => Effect.succeed(activeRunId ? [runs.get(activeRunId)!] : []),
    listQueuedManualRuns: () =>
      Effect.succeed(
        [...runs.values()].filter((run) => run.trigger === "manual" && run.status === "queued"),
      ),
    claimNextQueuedRun: () =>
      Effect.sync(() => {
        const queued = [...runs.values()].find(
          (run) => run.status === "queued" || run.status === "deferred",
        );
        if (!queued) return Option.none();
        activeRunId = queued.runId;
        return Option.some(queued);
      }),
    yieldActiveRunToManual: (scheduledId: string, manualId: string) =>
      Effect.sync(() => {
        const scheduled = runs.get(scheduledId)!;
        runs.set(scheduledId, { ...scheduled, status: "deferred" });
        const manual = runs.get(manualId)!;
        activeRunId = manualId;
        return Option.some(manual);
      }),
    transitionRun: (input: {
      readonly runId: string;
      readonly nextStatus: ThreadRetentionRun["status"];
      readonly updatedAt: string;
    }) =>
      Effect.sync(() => {
        if (activeRunId !== input.runId) return false;
        const current = runs.get(input.runId)!;
        const next = { ...current, status: input.nextStatus, updatedAt: input.updatedAt };
        runs.set(input.runId, next);
        if (input.nextStatus === "completed" || input.nextStatus === "completed_with_failures") {
          activeRunId = undefined;
        }
        return true;
      }),
    listOutstandingItems: () => Effect.succeed([]),
    selectNextPage: () =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          concurrent += 1;
          maximumConcurrent = Math.max(maximumConcurrent, concurrent);
          if (activeRunId) executionOrder.push(activeRunId);
        }),
        () => selectPage(activeRunId),
        () => Effect.sync(() => void (concurrent -= 1)),
      ),
    insertSelectedPage: () =>
      Effect.succeed({ applied: true, insertedCount: 0, outstandingBacklogCount: 0 }),
  };
  return {
    repository: repository as never,
    executionOrder,
    maximumConcurrent: () => maximumConcurrent,
    activeRunId: () => activeRunId,
    updateRun: (runId: string, update: (run: ThreadRetentionRun) => ThreadRetentionRun) => {
      runs.set(runId, update(runs.get(runId)!));
    },
    setSelectPage: (
      handler: (
        runId: string | undefined,
      ) => Effect.Effect<ReadonlyArray<ThreadRetentionCandidate>>,
    ) => {
      selectPage = handler;
    },
  };
}

const orchestration = {
  dispatch: () => Effect.succeed({ sequence: 1 }),
  streamDomainEvents: Stream.empty,
  getReadModel: () => Effect.succeed({ threads: [] } as never),
} as never;

describe("thread retention execution coordinator", () => {
  it("serializes concurrent manual executions", async () => {
    const first = {
      ...retentionRun,
      runId: "manual-first",
      trigger: "manual" as const,
      status: "queued" as const,
    };
    const second = {
      ...retentionRun,
      runId: "manual-second",
      trigger: "manual" as const,
      status: "queued" as const,
    };
    const state = makeCoordinatorRepository([first, second]);
    const coordinator = await Effect.runPromise(
      makeThreadRetentionExecutionCoordinator({ repository: state.repository, orchestration }),
    );
    await Effect.runPromise(
      Effect.all([coordinator.execute(first.runId), coordinator.execute(second.runId)], {
        concurrency: "unbounded",
      }),
    );
    expect(state.maximumConcurrent()).toBe(1);
    expect(state.executionOrder).toEqual([first.runId, second.runId]);
  });

  it("yields scheduled ownership to manual work and resumes without overlap", async () => {
    const scheduled = {
      ...retentionRun,
      runId: "scheduled-active",
      trigger: "scheduled" as const,
      status: "selecting" as const,
    };
    const manual = {
      ...retentionRun,
      runId: "manual-priority",
      trigger: "manual" as const,
      status: "queued" as const,
    };
    const state = makeCoordinatorRepository([scheduled, manual]);
    const repository = state.repository as unknown as {
      listRecoverableRuns: () => Effect.Effect<ReadonlyArray<ThreadRetentionRun>>;
    };
    const originalList = repository.listRecoverableRuns;
    let firstRead = true;
    repository.listRecoverableRuns = () => {
      if (firstRead) {
        firstRead = false;
        return Effect.succeed([scheduled]);
      }
      return originalList();
    };
    const coordinator = await Effect.runPromise(
      makeThreadRetentionExecutionCoordinator({ repository: state.repository, orchestration }),
    );
    await Effect.runPromise(coordinator.drain());
    expect(state.maximumConcurrent()).toBe(1);
    expect(state.executionOrder).toEqual([manual.runId, scheduled.runId]);
  });

  it("hands off at the next persisted selection-page boundary", async () => {
    const scheduled = {
      ...retentionRun,
      runId: "scheduled-page-owner",
      trigger: "scheduled" as const,
      status: "selecting" as const,
    };
    const manual = {
      ...retentionRun,
      runId: "manual-arrives-during-selection",
      trigger: "manual" as const,
      status: "deferred" as const,
    };
    const state = makeCoordinatorRepository([scheduled, manual]);
    let scheduledPages = 0;
    state.setSelectPage((activeRunId) =>
      Effect.sync(() => {
        if (activeRunId !== scheduled.runId || scheduledPages++ > 0) return [];
        state.updateRun(manual.runId, (run) => ({ ...run, status: "queued" }));
        return [
          {
            threadId: ThreadId.makeUnsafe("scheduled-persisted-page"),
            lastActivityAt: "2026-08-16T00:00:00.000Z",
          },
        ];
      }),
    );
    const coordinator = await Effect.runPromise(
      makeThreadRetentionExecutionCoordinator({ repository: state.repository, orchestration }),
    );

    await Effect.runPromise(coordinator.drain());

    expect(state.maximumConcurrent()).toBe(1);
    expect(state.executionOrder).toEqual([scheduled.runId, manual.runId, scheduled.runId]);
  });
});
