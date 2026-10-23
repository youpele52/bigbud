import * as OS from "node:os";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import { Cause, Effect, Layer, Option } from "effect";

import { ServerSpanActivity } from "../../observability/Services/ServerSpanActivity.ts";
import { TRACE_RETAIN_ATTRIBUTE } from "../../observability/TracePolicy.ts";
import { ServerLifecycleEvents } from "../../startup/serverLifecycleEvents.ts";
import {
  buildStalledPayload,
  classifyLoopGap,
  EVENT_LOOP_HISTOGRAM_RESOLUTION_MS,
  EVENT_LOOP_SAMPLE_INTERVAL_MS,
  EVENT_LOOP_WINDOW_MS,
  type LoopClockReading,
  loopSleepClockForPlatform,
  shouldRetainEventLoopWindow,
  summarizeEventLoopWindow,
} from "../EventLoopLagMonitor.logic.ts";
import { ConnectionDiagnostics } from "../Services/ConnectionDiagnostics.ts";
import { SystemSleepEpochs } from "../../system-sleep/Services/SystemSleepEpochs.ts";
import { SERVER_STALL_MAX_SPANS } from "@bigbud/contracts/constants/connectionDiagnostics.constant.ts";

export const EVENT_LOOP_WINDOW_SPAN = "server.event_loop.window";

export interface EventLoopLagMonitorOptions {
  readonly sampleIntervalMs?: number;
  readonly windowMs?: number;
  readonly thresholdMs?: number;
  /** Whether the monotonic clock counts system sleep; defaults to true on macOS and Windows. */
  readonly monotonicIncludesSleep?: boolean;
  /** Whether `boottimeMs` counts sleep the monotonic clock misses; defaults to true on Linux. */
  readonly boottimeCountsSleep?: boolean;
  /** Clock source, injectable for tests. */
  readonly readClock?: () => LoopClockReading;
}

const platformSleepClock = loopSleepClockForPlatform(process.platform);

const readLoopClock = (): LoopClockReading => {
  const cpu = process.cpuUsage();
  return {
    monotonicMs: performance.now(),
    wallMs: Date.now(),
    cpuMs: (cpu.user + cpu.system) / 1_000,
    ...(platformSleepClock.boottimeCountsSleep ? { boottimeMs: OS.uptime() * 1_000 } : {}),
  };
};

/**
 * Measures the server's own event-loop health. A drift sampler publishes a
 * `stalled` lifecycle event once a single stall of at least the threshold
 * ends, and a `monitorEventLoopDelay` histogram writes p50, p99 and max per
 * window into the trace. Both loops are scoped fibers; the histogram is
 * disabled when the scope closes.
 */
export const makeEventLoopLagMonitor = Effect.fn("makeEventLoopLagMonitor")(function* (
  options: EventLoopLagMonitorOptions = {},
) {
  const sampleIntervalMs = options.sampleIntervalMs ?? EVENT_LOOP_SAMPLE_INTERVAL_MS;
  const windowMs = options.windowMs ?? EVENT_LOOP_WINDOW_MS;
  const readClock = options.readClock ?? readLoopClock;
  const monotonicIncludesSleep =
    options.monotonicIncludesSleep ?? platformSleepClock.monotonicIncludesSleep;
  const boottimeCountsSleep = options.boottimeCountsSleep ?? platformSleepClock.boottimeCountsSleep;
  const classifyGap = (previous: LoopClockReading, now: LoopClockReading, intervalMs: number) =>
    classifyLoopGap({
      previous,
      now,
      intervalMs,
      monotonicIncludesSleep,
      boottimeCountsSleep,
      ...(options.thresholdMs === undefined ? {} : { thresholdMs: options.thresholdMs }),
    });
  const lifecycleEvents = yield* ServerLifecycleEvents;
  const diagnostics = yield* ConnectionDiagnostics;
  const spanActivity = yield* Effect.serviceOption(ServerSpanActivity);
  const sleepEpochs = yield* Effect.serviceOption(SystemSleepEpochs);
  const histogram = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const created = monitorEventLoopDelay({ resolution: EVENT_LOOP_HISTOGRAM_RESOLUTION_MS });
      created.enable();
      return created;
    }),
    (created) => Effect.sync(() => created.disable()),
  );
  let stallCount = 0;
  let previousTick = readClock();

  const reportStall = (durationMs: number) =>
    Effect.gen(function* () {
      const endedAtMs = Date.now();
      const runningSpans = Option.match(spanActivity, {
        onNone: () => [],
        onSome: (activity) =>
          activity.stallCandidates(endedAtMs - durationMs, endedAtMs, SERVER_STALL_MAX_SPANS),
      });
      const payload = buildStalledPayload({ endedAtMs, durationMs, runningSpans });
      yield* lifecycleEvents.publish({ version: 1, type: "stalled", payload });
      yield* diagnostics.recordStall(payload);
    });

  const sample = Effect.gen(function* () {
    yield* Effect.sleep(sampleIntervalMs);
    const now = readClock();
    const gap = classifyGap(previousTick, now, sampleIntervalMs);
    previousTick = now;
    if (gap?.kind === "stall") {
      stallCount += 1;
      yield* reportStall(gap.durationMs);
    } else if (gap?.kind === "system-sleep") {
      // Not a stall: logged and kept in the diagnostics ring, never published as `stalled`.
      yield* diagnostics.recordSuspectedSystemSleep({
        endedAtMs: now.wallMs,
        durationMs: gap.durationMs,
      });
      if (Option.isSome(sleepEpochs)) {
        yield* sleepEpochs.value.recordEvidence({
          source: "server-gap",
          startedAtMs: now.wallMs - gap.durationMs,
          endedAtMs: now.wallMs,
        });
      }
    }
  });

  let windowStarted = readClock();
  const flushWindow = Effect.gen(function* () {
    yield* Effect.sleep(windowMs);
    const now = readClock();
    const gap = classifyGap(windowStarted, now, windowMs);
    const window = summarizeEventLoopWindow({
      histogram,
      endedAtMs: now.wallMs,
      windowMs: now.monotonicMs - windowStarted.monotonicMs,
      stallCount,
    });
    histogram.reset();
    stallCount = 0;
    windowStarted = now;
    // A window that spans a system sleep measures the sleep, not the event loop.
    if (gap?.kind === "system-sleep") return;
    yield* diagnostics.recordEventLoopWindow(window);
    if (!shouldRetainEventLoopWindow(window)) return;
    yield* Effect.void.pipe(
      Effect.withSpan(EVENT_LOOP_WINDOW_SPAN, {
        root: true,
        attributes: {
          "event_loop.window_ms": window.windowMs,
          "event_loop.p50_ms": window.p50Ms,
          "event_loop.p99_ms": window.p99Ms,
          "event_loop.max_ms": window.maxMs,
          "event_loop.stall_count": window.stallCount,
          [TRACE_RETAIN_ATTRIBUTE]: true,
        },
      }),
    );
  });

  // Diagnostics must never take the server down; a failed iteration is skipped.
  const resilient = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.void,
      ),
      Effect.forever,
      Effect.forkScoped,
    );
  yield* resilient(sample);
  yield* resilient(flushWindow);
});

export const EventLoopLagMonitorLive = Layer.effectDiscard(makeEventLoopLagMonitor());
