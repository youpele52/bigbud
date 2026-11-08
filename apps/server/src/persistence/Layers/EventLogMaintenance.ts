/**
 * EventLogMaintenanceLive - restores automatic event-log compaction and adds ledger pruning.
 *
 * - Ticks every 2 minutes, and every 15 seconds while a backlog remains, after a 3-minute
 *   startup delay (after the deletion upkeep loops' 2 minutes; startup is the worker's busiest
 *   time).
 * - Deletes only below the floor (`EventLogMaintenance.floor`) through the existing
 *   `compactVerifiedPrefix`, in adaptive batches of at most about 50 ms with a 1-second tick
 *   budget (`EventLogMaintenance.batches`).
 * - Skips under load and guarantees progress (`EventLogMaintenance.scheduler`).
 * - Drives the other background steps after each tick under the same load decision: attachment
 *   maintenance and the database steady-state step (`EventLogMaintenance.steps`). The loop is
 *   started by `EventLogMaintenanceSchedulerLive`, built after those services, because
 *   `DatabaseCompaction` itself reads this service's progress.
 * - `BIGBUD_DISABLE_EVENT_LOG_MAINTENANCE=1` stops event-log deletion (progress reads
 *   `disabled`); the other steps still run.
 *
 * @module EventLogMaintenance
 */
import type { EventLogMaintenanceProgress } from "@bigbud/contracts/server/eventLogMaintenance.ts";
import { Cause, type Duration, Effect, Layer, Option } from "effect";

import { AttachmentMaintenance } from "../../attachments/Services/AttachmentMaintenance.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ConnectionDiagnostics } from "../../connection-diagnostics/Services/ConnectionDiagnostics.ts";
import { DesktopSupervisorDelivery } from "../../desktop-supervisor/desktopSupervisorDelivery.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../../orchestration/Services/ProjectionPipeline.ts";
import { backgroundSqlActivityCount } from "../backgroundSqlActivity.ts";
import { nodeSqliteWriterQueueDepth } from "../NodeSqliteClient.worker.bridge.ts";
import { DatabaseCompaction } from "../Services/DatabaseCompaction.ts";
import {
  EventLogMaintenance,
  type EventLogMaintenanceShape,
  type MaintenanceSchedulerSteps,
} from "../Services/EventLogMaintenance.ts";
import { makeCompactVerifiedPrefix } from "./OrchestrationEventStore.compaction.ts";
import { initialBatchSizers } from "./EventLogMaintenance.batches.ts";
import { isEventLogFloorPinned } from "./EventLogMaintenance.floor.ts";
import {
  DeletionRate,
  MAINTENANCE_FAILURE_BACKOFF_MS,
  MAINTENANCE_LOAD,
  type MaintenanceLoadSignals,
  nextTickDelayMs,
} from "./EventLogMaintenance.scheduler.ts";
import { readEventLogMaintenanceState } from "./EventLogMaintenance.state.ts";
import {
  initialSchedulerStepsMemory,
  NO_SCHEDULER_STEPS,
  runSchedulerSteps,
} from "./EventLogMaintenance.steps.ts";
import {
  type MaintenanceMemory,
  type MaintenanceRuntime,
  runMaintenanceTick,
} from "./EventLogMaintenance.tick.ts";

const START_DELAY: Duration.Input = "3 minutes";
const STALL_LOOKBACK_MS = 60_000;

export interface EventLogMaintenanceOptions {
  readonly now?: () => number;
  readonly clock?: () => number;
  /** Replaces the live load signals (tests). */
  readonly readSignals?: MaintenanceRuntime["readSignals"];
  /** Replaces the live reactor and delivery cursors (tests). */
  readonly floorInputs?: MaintenanceRuntime["floorInputs"];
  /** Observes every batch (measurement harnesses). */
  readonly onBatch?: MaintenanceRuntime["onBatch"];
  /** Replaces the compaction batch (tests). */
  readonly compact?: MaintenanceRuntime["compact"];
  /** Replaces the pipeline's baseline verification (tests). */
  readonly refreshBaseline?: MaintenanceRuntime["refreshBaseline"];
  /** Replaces the 50,000-sequence / 24-hour hot window (tests). */
  readonly hotWindow?: { readonly sequences: number; readonly ms: number };
}

const toIso = (value: number | null) => (value === null ? null : new Date(value).toISOString());

export const makeEventLogMaintenance = Effect.fn("makeEventLogMaintenance")(function* (
  options: EventLogMaintenanceOptions = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* Effect.serviceOption(OrchestrationEngineService);
  const pipeline = yield* Effect.serviceOption(OrchestrationProjectionPipeline);
  const refreshBaseline =
    options.refreshBaseline ??
    (Option.isSome(pipeline)
      ? pipeline.value.ensureVerifiedBaselineThroughWithoutCompaction
      : undefined);
  const delivery = yield* Effect.serviceOption(DesktopSupervisorDelivery);
  const diagnostics = yield* Effect.serviceOption(ConnectionDiagnostics);
  const now = options.now ?? (() => Date.now());
  const compactVerifiedPrefix = makeCompactVerifiedPrefix(sql);
  let steps: MaintenanceSchedulerSteps = NO_SCHEDULER_STEPS;
  const compactionRunning = Effect.suspend(() =>
    steps.compaction === null
      ? Effect.succeed(false)
      : steps.compaction.status.pipe(Effect.map((status) => status.state === "running")),
  );

  const lagged = Effect.gen(function* () {
    if (Option.isNone(diagnostics)) return false;
    const snapshot = yield* diagnostics.value.snapshot(20);
    const window = snapshot.eventLoop;
    const sinceMs = now() - STALL_LOOKBACK_MS;
    const recentStall = snapshot.serverEvents.some(
      (event) => event.type === "stalled" && Date.parse(event.payload.endedAt) >= sinceMs,
    );
    return (
      recentStall ||
      (window !== null &&
        Date.parse(window.endedAt) >= sinceMs &&
        window.p99Ms > MAINTENANCE_LOAD.eventLoopLagMs)
    );
  });
  const streamingTurns = sql<{ readonly count: number }>`
    SELECT COUNT(*) AS "count" FROM projection_thread_sessions
    WHERE active_turn_id IS NOT NULL AND status IN ('starting', 'running')
  `.pipe(
    Effect.map((rows) => rows[0]?.count ?? 0),
    // An unreadable count is treated as busy rather than idle.
    Effect.catch(() => Effect.succeed(Number.MAX_SAFE_INTEGER)),
  );
  const liveSignals = (batchInFlight: boolean) =>
    Effect.gen(function* () {
      return {
        queueDepth: nodeSqliteWriterQueueDepth(),
        eventLoopLagged: yield* lagged,
        streamingTurns: yield* streamingTurns,
        backgroundActive: backgroundSqlActivityCount(),
        batchInFlight,
        databaseCompactionRunning: yield* compactionRunning,
      } satisfies MaintenanceLoadSignals;
    });

  const disabled = process.env.BIGBUD_DISABLE_EVENT_LOG_MAINTENANCE === "1";
  const runtime: MaintenanceRuntime = {
    sql,
    ...(disabled ? { batchesDisabled: true } : {}),
    compact:
      options.compact ??
      ((batchSize, throughSequence) => compactVerifiedPrefix(batchSize, { throughSequence })),
    readSignals: options.readSignals ?? liveSignals,
    floorInputs:
      options.floorInputs ??
      (() => ({
        reactorCursor: Option.isSome(engine)
          ? (engine.value.oldestReactorCursor?.() ?? null)
          : null,
        deliveryAcknowledged: Option.isSome(delivery)
          ? (delivery.value.lowestAcknowledgedSequence?.() ?? null)
          : null,
      })),
    ...(refreshBaseline ? { refreshBaseline } : {}),
    now,
    clock: options.clock ?? (() => performance.now()),
    ...(options.hotWindow ? { hotWindow: options.hotWindow } : {}),
    ...(options.onBatch ? { onBatch: options.onBatch } : {}),
  };
  const memory: MaintenanceMemory = {
    state: yield* readEventLogMaintenanceState(sql),
    sizers: initialBatchSizers(),
    rate: new DeletionRate(),
    startedAtMs: now(),
    inFlight: false,
    baselineRefreshAtMs: null,
    floorReadAtMs: null,
    receiptsRescanAtMs: null,
    minimumTurn: 0,
    ticks: 0,
  };
  // The longest batch is reported per process run.
  memory.state = { ...memory.state, longestBatchMs: 0 };
  const stepsMemory = initialSchedulerStepsMemory(now());

  /** A tick that cannot even read the floor backs off like a failed batch. */
  const runTick = runMaintenanceTick(runtime, memory).pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
      const nowMs = now();
      memory.state = {
        ...memory.state,
        lastError: Cause.pretty(cause).slice(0, 500),
        lastErrorAtMs: nowMs,
        backoffUntilMs: nowMs + MAINTENANCE_FAILURE_BACKOFF_MS,
      };
      return Effect.logWarning("event log maintenance tick failed; backing off", {
        cause: Cause.pretty(cause),
      }).pipe(
        Effect.as({
          mode: "backoff" as const,
          reason: "tick-failed",
          floorSequence: memory.state.floorSequence,
          retainedThroughSequence: memory.state.retainedThroughSequence,
          backlogSequences: memory.state.backlogSequences,
          eventsDeleted: 0,
          gapsDeleted: 0,
          receiptsDeleted: 0,
          claimsDeleted: 0,
          eventIdsDeleted: 0,
          batches: 0,
          slowBatches: 0,
          longestBatchMs: 0,
          longestCheckpointMs: 0,
          elapsedMs: 0,
          drained: false,
          failed: true,
          idle: false,
        }),
      );
    }),
  );

  const progress: EventLogMaintenanceShape["progress"] = Effect.sync(() => {
    const { state } = memory;
    const nowMs = now();
    const backingOff = state.backoffUntilMs !== null && nowMs < state.backoffUntilMs;
    return {
      state: disabled
        ? "disabled"
        : memory.ticks === 0
          ? "waiting"
          : backingOff
            ? "backing-off"
            : state.backlogSequences > 0
              ? "draining"
              : "idle",
      backlogSequences: Math.max(0, state.backlogSequences),
      floorSequence: Math.max(0, state.floorSequence),
      floorHeldBy: state.floorHeldBy,
      floorPinned: isEventLogFloorPinned(state.floorPinnedSinceMs, nowMs),
      floorPinnedSince: toIso(state.floorPinnedSinceMs),
      retainedThroughSequence: Math.max(0, state.retainedThroughSequence),
      ratePerMinute: memory.rate.perMinute(nowMs),
      lastBatchAt: toIso(state.lastBatchAtMs),
      longestBatchMs: state.longestBatchMs,
      starved: state.starvedSinceMs !== null,
      starvedSince: toIso(state.starvedSinceMs),
      lastError: state.lastError,
      lastErrorAt: toIso(state.lastErrorAtMs),
      backoffUntil: backingOff ? toIso(state.backoffUntilMs) : null,
    } satisfies EventLogMaintenanceProgress;
  });

  const runScheduler: EventLogMaintenanceShape["runScheduler"] = (next) =>
    Effect.gen(function* () {
      steps = next;
      yield* Effect.sleep(START_DELAY);
      for (;;) {
        const report = yield* runTick;
        yield* runSchedulerSteps(steps, stepsMemory, report, now());
        const backlog = report.backlogSequences + stepsMemory.attachmentsBacklog;
        yield* Effect.sleep(nextTickDelayMs(backlog));
      }
    });

  return {
    service: { progress, runTick, runScheduler } satisfies EventLogMaintenanceShape,
  };
});

/** The service only; `EventLogMaintenanceSchedulerLive` starts its loop. */
export const EventLogMaintenanceLive = Layer.effect(
  EventLogMaintenance,
  Effect.map(makeEventLogMaintenance(), (maintenance) => maintenance.service),
);

/**
 * Starts the shared maintenance loop with whichever of attachment maintenance and database
 * compaction are composed. Provide it after (above) those layers and `EventLogMaintenanceLive`.
 */
export const EventLogMaintenanceSchedulerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const maintenance = yield* EventLogMaintenance;
    const attachments = yield* Effect.serviceOption(AttachmentMaintenance);
    const compaction = yield* Effect.serviceOption(DatabaseCompaction);
    yield* Effect.forkScoped(
      maintenance.runScheduler({
        attachments: Option.getOrNull(attachments),
        compaction: Option.getOrNull(compaction),
      }),
    );
  }),
);
