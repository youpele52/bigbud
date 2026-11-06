/**
 * Pure analysis behind `connection-health-report.ts`. It turns the packaged app's own logs
 * into the numbers the connection-resilience plan is judged by, so a fix is accepted on
 * measured evidence rather than on how the app feels.
 */

export interface ServerChildLogMetrics {
  /** Backend processes that died from a V8 heap out-of-memory abort. */
  readonly heapOutOfMemoryAborts: number;
  readonly stalls: { readonly overOneSecond: number; readonly overFiveSeconds: number };
  readonly longestStallMs: number;
  readonly discoveryScans: number;
  /**
   * Most discovery scans in any ten-minute window. The log clock has no date, so a clock
   * that jumps back by more than an hour starts a new day; logs must be read oldest first.
   */
  readonly peakDiscoveryScansPerTenMinutes: number;
}

export interface TraceMetrics {
  readonly stallsOverFiveSeconds: number;
  readonly sqlSpansOverTenSeconds: number;
  readonly reconnects: number;
  /**
   * Reconnects after which the same consumer opened no live delivery session within the
   * grace window. This is the "connected but frozen" signature. Sessions still open when
   * the trace ends are not written yet, so the newest reconnects can read as orphaned.
   */
  readonly reconnectsWithoutDeliverySession: number;
}

const GC_ABORT_LINE = /^\[(\d+):0x[0-9a-f]+\]\s+\d+ ms: Mark-Compact/;
const STALL_DURATION_LINE = /stall\.duration_ms:\s*(\d+)/;
const LOG_CLOCK = /^\[(\d\d):(\d\d):\d\d/;
const DAY_ROLLOVER_MINUTES = 60;

export function analyzeServerChildLog(text: string): ServerChildLogMetrics {
  const abortedPids = new Set<string>();
  let overOneSecond = 0;
  let overFiveSeconds = 0;
  let longestStallMs = 0;
  let discoveryScans = 0;
  const scansByWindow = new Map<string, number>();
  let awaitingStallDuration = false;
  let day = 0;
  let previousMinuteOfDay: number | null = null;

  for (const line of text.split("\n")) {
    const clock = LOG_CLOCK.exec(line);
    if (clock) {
      const minuteOfDay = Number(clock[1]) * 60 + Number(clock[2]);
      if (
        previousMinuteOfDay !== null &&
        minuteOfDay < previousMinuteOfDay - DAY_ROLLOVER_MINUTES
      ) {
        day += 1;
      }
      previousMinuteOfDay = minuteOfDay;
    }
    const gc = GC_ABORT_LINE.exec(line);
    if (gc?.[1] && line.includes("last resort")) abortedPids.add(gc[1]);

    if (line.includes("server event loop stalled")) {
      awaitingStallDuration = true;
      continue;
    }
    const duration = awaitingStallDuration ? STALL_DURATION_LINE.exec(line) : null;
    if (duration?.[1]) {
      awaitingStallDuration = false;
      const ms = Number(duration[1]);
      if (ms > 1_000) overOneSecond += 1;
      if (ms > 5_000) overFiveSeconds += 1;
      longestStallMs = Math.max(longestStallMs, ms);
    }

    if (line.includes("[DiscoveryRegistry] scanDiscoveryFiles")) {
      discoveryScans += 1;
      if (clock) {
        const window = `${day}|${clock[1]}:${clock[2]![0]}`;
        scansByWindow.set(window, (scansByWindow.get(window) ?? 0) + 1);
      }
    }
  }

  return {
    heapOutOfMemoryAborts: abortedPids.size,
    stalls: { overOneSecond, overFiveSeconds },
    longestStallMs,
    discoveryScans,
    peakDiscoveryScansPerTenMinutes: Math.max(0, ...scansByWindow.values()),
  };
}

interface TraceSpan {
  readonly name?: string;
  readonly startTimeUnixNano?: string;
  readonly durationMs?: number;
  readonly attributes?: Record<string, unknown>;
}

const startMs = (span: TraceSpan) => Number(span.startTimeUnixNano ?? 0) / 1_000_000;

/** A reconnected consumer must open a delivery session within this window to count as live. */
export const DELIVERY_RESUBSCRIBE_GRACE_MS = 30_000;

export function analyzeTrace(lines: Iterable<string>): TraceMetrics {
  let stallsOverFiveSeconds = 0;
  let sqlSpansOverTenSeconds = 0;
  const reconnects: Array<{ readonly consumer: string; readonly atMs: number }> = [];
  const sessionStarts = new Map<string, Array<number>>();

  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    let span: TraceSpan;
    try {
      span = JSON.parse(line) as TraceSpan;
    } catch {
      continue;
    }
    const attributes = span.attributes ?? {};
    switch (span.name) {
      case "server.stalled":
        if (Number(attributes["stall.duration_ms"] ?? 0) > 5_000) stallsOverFiveSeconds += 1;
        break;
      case "sql.execute":
      case "sql.transaction":
        if ((span.durationMs ?? 0) > 10_000) sqlSpansOverTenSeconds += 1;
        break;
      case "ws.connection.diagnostics":
        if (attributes["connection.trigger"] === "reconnect-success") {
          reconnects.push({
            consumer: String(attributes["connection.consumer_id"]),
            atMs: startMs(span),
          });
        }
        break;
      case "orchestration.delivery.session.ended": {
        const consumer = String(attributes["delivery.consumer_id"]);
        const opened = startMs(span) - Number(attributes["delivery.duration_ms"] ?? 0);
        sessionStarts.set(consumer, [...(sessionStarts.get(consumer) ?? []), opened]);
        break;
      }
    }
  }

  const reconnectsWithoutDeliverySession = reconnects.filter(
    ({ consumer, atMs }) =>
      !(sessionStarts.get(consumer) ?? []).some(
        (opened) => opened >= atMs - 5_000 && opened <= atMs + DELIVERY_RESUBSCRIBE_GRACE_MS,
      ),
  ).length;

  return {
    stallsOverFiveSeconds,
    sqlSpansOverTenSeconds,
    reconnects: reconnects.length,
    reconnectsWithoutDeliverySession,
  };
}
