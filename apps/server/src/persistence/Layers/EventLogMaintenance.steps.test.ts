import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import type {
  AttachmentMaintenanceShape,
  AttachmentMaintenanceTickResult,
} from "../../attachments/Services/AttachmentMaintenance.ts";
import type {
  DatabaseCompactionShape,
  DatabaseSteadyStateStepInput,
} from "../Services/DatabaseCompaction.ts";
import { decideTick, MAINTENANCE_GUARANTEED_PROGRESS_MS } from "./EventLogMaintenance.scheduler.ts";
import {
  decideAttachmentStep,
  initialSchedulerStepsMemory,
  runSchedulerSteps,
} from "./EventLogMaintenance.steps.ts";
import { IDLE_SIGNALS } from "./EventLogMaintenance.test.helpers.ts";

const NOW = 1_000_000_000;
const MINUTE = 60_000;

const tickResult = (backlog: number, processed: number): AttachmentMaintenanceTickResult => ({
  status: "completed",
  backlog,
  processed,
  budgetExhausted: false,
  durationMs: 1,
  backfill: { scanned: 0, recorded: 0, skipped: 0, pending: 0 },
  sweep: {
    scanned: 0,
    trashed: 0,
    deleted: 0,
    restored: 0,
    uploadDirectoriesRemoved: processed,
    held: 0,
    failed: 0,
    pending: backlog,
  },
});

const fakeAttachments = (results: Array<AttachmentMaintenanceTickResult>) => {
  const budgets: Array<number | undefined> = [];
  const service: AttachmentMaintenanceShape = {
    runTick: (options) => {
      budgets.push(options?.budgetMs);
      return Effect.succeed(results.shift() ?? tickResult(0, 0));
    },
  };
  return { service, budgets };
};

const fakeCompaction = () => {
  const inputs: Array<DatabaseSteadyStateStepInput | undefined> = [];
  const service = {
    runSteadyStateStep: (input?: DatabaseSteadyStateStepInput) => {
      inputs.push(input);
      return Effect.succeed({
        skipped: null,
        journalSizeLimitApplied: false,
        autoVacuumIncremental: true,
        freeFractionBefore: 0,
        pagesReleased: 0,
        checkpoint: null,
        elapsedMs: 1,
        error: null,
      });
    },
  } as unknown as DatabaseCompactionShape;
  return { service, inputs };
};

describe("attachment step decision", () => {
  it("runs fully when idle, waits for its cadence, and never on a hard skip", () => {
    const memory = initialSchedulerStepsMemory(NOW);
    assert.deepEqual(decideAttachmentStep({ mode: "full", nowMs: NOW, memory }), {
      budgetMs: 1_000,
    });
    assert.isNull(decideAttachmentStep({ mode: "skip-hard", nowMs: NOW, memory }));
    const notDue = { ...memory, attachmentsDueAtMs: NOW + MINUTE };
    assert.isNull(decideAttachmentStep({ mode: "full", nowMs: NOW, memory: notDue }));
  });

  it("under soft load runs a 50 ms tick once 10 minutes pass without progress", () => {
    const fresh = { ...initialSchedulerStepsMemory(NOW), attachmentsBacklog: 5 };
    assert.isNull(decideAttachmentStep({ mode: "skip-soft", nowMs: NOW + MINUTE, memory: fresh }));
    const starving = NOW + MAINTENANCE_GUARANTEED_PROGRESS_MS;
    for (const mode of ["skip-soft", "minimum", "backoff"] as const) {
      assert.deepEqual(decideAttachmentStep({ mode, nowMs: starving, memory: fresh }), {
        budgetMs: 50,
      });
    }
    // An empty backlog still gets the tick: it starts with the trash restore pass.
    const empty = initialSchedulerStepsMemory(NOW);
    assert.isNull(decideAttachmentStep({ mode: "skip-soft", nowMs: NOW + MINUTE, memory: empty }));
    assert.deepEqual(decideAttachmentStep({ mode: "skip-soft", nowMs: starving, memory: empty }), {
      budgetMs: 50,
    });
  });
});

describe("scheduler steps", () => {
  it.effect("runs the attachment tick, then the steady-state step with the tick's idleness", () =>
    Effect.gen(function* () {
      const attachments = fakeAttachments([tickResult(3, 2), tickResult(0, 3)]);
      const compaction = fakeCompaction();
      const steps = { attachments: attachments.service, compaction: compaction.service };
      const memory = initialSchedulerStepsMemory(NOW);

      yield* runSchedulerSteps(steps, memory, { mode: "full" }, NOW);
      assert.deepEqual(attachments.budgets, [1_000]);
      assert.equal(memory.attachmentsBacklog, 3);
      // A backlog brings the next attachment tick forward to 15 seconds.
      assert.equal(memory.attachmentsDueAtMs, NOW + 15_000);

      yield* runSchedulerSteps(steps, memory, { mode: "skip-soft" }, NOW + 20_000);
      assert.lengthOf(attachments.budgets, 1, "soft load without starvation skips attachments");
      yield* runSchedulerSteps(steps, memory, { mode: "skip-hard" }, NOW + 30_000);
      assert.deepEqual(
        compaction.inputs.map((input) => input?.idle),
        [true, false],
        "the steady-state step runs after full and soft ticks, never after a hard skip",
      );
    }),
  );

  it.effect("tolerates absent services", () =>
    Effect.gen(function* () {
      const memory = initialSchedulerStepsMemory(NOW);
      const step = yield* runSchedulerSteps(
        { attachments: null, compaction: null },
        memory,
        { mode: "full" },
        NOW,
      );
      assert.isNull(step);
    }),
  );
});

it("skips every batch, including guaranteed progress, while the database rebuild runs", () => {
  const decision = decideTick({
    nowMs: NOW,
    signals: { ...IDLE_SIGNALS, queueDepth: 8, databaseCompactionRunning: true },
    backlog: 10_000,
    lastProgressAtMs: NOW - 2 * MAINTENANCE_GUARANTEED_PROGRESS_MS,
    backoffUntilMs: null,
  });
  assert.deepEqual(decision, { mode: "skip-hard", reason: "database-compaction-running" });
});
