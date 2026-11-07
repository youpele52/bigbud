/**
 * The other background steps the event-log maintenance scheduler runs after each tick, outside
 * any batch transaction and under the same load decision:
 *
 * - attachment maintenance (`AttachmentMaintenance.runTick`): a full tick when the tick found
 *   no load (`full`, or a failure `backoff` with no load signal), every 5 minutes (15 seconds while a backlog remains); under soft load only a
 *   50 ms guaranteed-progress tick once a backlog has seen no progress for 10 minutes; never on
 *   a hard skip;
 * - the database steady-state step (`DatabaseCompaction.runSteadyStateStep`): incremental
 *   vacuum and the idle WAL truncate, with `idle` true only when the tick found no load.
 *
 * An event-log failure backoff is not load, so it does not slow either step.
 *
 * Both services are optional; a step whose service is absent is skipped.
 *
 * @module EventLogMaintenance.steps
 */
import { Cause, Effect, Exit } from "effect";

import {
  ATTACHMENT_MAINTENANCE_SCHEDULE,
  logAttachmentMaintenanceTick,
} from "../../attachments/Layers/AttachmentMaintenance.scheduler.ts";
import type { AttachmentMaintenanceShape } from "../../attachments/Services/AttachmentMaintenance.ts";
import type { DatabaseSteadyStateStepReport } from "../Services/DatabaseCompaction.ts";
import type {
  EventLogMaintenanceTickMode,
  EventLogMaintenanceTickReport,
  MaintenanceSchedulerSteps,
} from "../Services/EventLogMaintenance.ts";
import {
  MAINTENANCE_BATCH,
  MAINTENANCE_GUARANTEED_PROGRESS_MS,
} from "./EventLogMaintenance.scheduler.ts";

export const NO_SCHEDULER_STEPS: MaintenanceSchedulerSteps = {
  attachments: null,
  compaction: null,
};

export interface SchedulerStepsMemory {
  /** The next attachment tick is not due before this time. */
  attachmentsDueAtMs: number;
  attachmentsBacklog: number;
  /** Last attachment tick that made progress or found nothing to do. */
  attachmentsProgressAtMs: number;
}

export const initialSchedulerStepsMemory = (nowMs: number): SchedulerStepsMemory => ({
  attachmentsDueAtMs: nowMs,
  attachmentsBacklog: 0,
  attachmentsProgressAtMs: nowMs,
});

type StepsTick = Pick<EventLogMaintenanceTickReport, "mode"> &
  Partial<Pick<EventLogMaintenanceTickReport, "idle">>;

/** Whether the event-log tick found no load; a `full` tick always did. */
const tickWasIdle = (tick: StepsTick) => tick.mode === "full" || tick.idle === true;

/** Pure: whether the attachment tick runs after an event-log tick of `mode`, and how much. */
export function decideAttachmentStep(input: {
  readonly mode: EventLogMaintenanceTickMode;
  /** No load signal (see `EventLogMaintenanceTickReport.idle`); implied by `full`. */
  readonly idle?: boolean;
  readonly nowMs: number;
  readonly memory: SchedulerStepsMemory;
}): { readonly budgetMs: number } | null {
  const { memory, nowMs } = input;
  if (input.mode === "skip-hard" || nowMs < memory.attachmentsDueAtMs) return null;
  if (tickWasIdle(input)) return { budgetMs: ATTACHMENT_MAINTENANCE_SCHEDULE.budgetMs };
  // Not gated on backlog: the tick starts with the trash restore pass, which must run even when
  // nothing is left to sweep (a file trashed by mistake is put back within 10 minutes).
  const starving = nowMs - memory.attachmentsProgressAtMs >= MAINTENANCE_GUARANTEED_PROGRESS_MS;
  return starving ? { budgetMs: ATTACHMENT_MAINTENANCE_SCHEDULE.minimumBudgetMs } : null;
}

const runAttachmentStep = Effect.fn("EventLogMaintenance.attachmentStep")(function* (
  attachments: AttachmentMaintenanceShape,
  memory: SchedulerStepsMemory,
  tick: StepsTick,
  nowMs: number,
) {
  const decision = decideAttachmentStep({ ...tick, nowMs, memory });
  if (decision === null) return;
  const exit = yield* Effect.exit(attachments.runTick({ budgetMs: decision.budgetMs }));
  if (Exit.isFailure(exit)) {
    if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt;
    memory.attachmentsDueAtMs = nowMs + ATTACHMENT_MAINTENANCE_SCHEDULE.idleIntervalMs;
    yield* Effect.logWarning("attachment maintenance tick failed", {
      cause: Cause.pretty(exit.cause),
    });
    return;
  }
  const result = exit.value;
  if (result.status !== "completed") return;
  memory.attachmentsBacklog = result.backlog;
  if (result.processed > 0 || result.backlog === 0) memory.attachmentsProgressAtMs = nowMs;
  memory.attachmentsDueAtMs =
    nowMs +
    (result.backlog > 0
      ? ATTACHMENT_MAINTENANCE_SCHEDULE.backlogIntervalMs
      : ATTACHMENT_MAINTENANCE_SCHEDULE.idleIntervalMs);
  yield* logAttachmentMaintenanceTick(result);
});

/** Runs after a tick; never fails. Returns the steady-state report when that step ran. */
export const runSchedulerSteps = Effect.fn("EventLogMaintenance.schedulerSteps")(function* (
  steps: MaintenanceSchedulerSteps,
  memory: SchedulerStepsMemory,
  report: StepsTick,
  nowMs: number,
) {
  if (steps.attachments !== null) {
    yield* runAttachmentStep(steps.attachments, memory, report, nowMs);
  }
  if (steps.compaction === null || report.mode === "skip-hard") return null;
  const step: DatabaseSteadyStateStepReport = yield* steps.compaction.runSteadyStateStep({
    idle: tickWasIdle(report),
  });
  if (step.elapsedMs > MAINTENANCE_BATCH.targetMs) {
    yield* Effect.logWarning("database steady-state step exceeded the batch target", {
      elapsedMs: Math.round(step.elapsedMs),
      pagesReleased: step.pagesReleased,
      checkpoint: step.checkpoint,
    });
  }
  return step;
});
