import { END_SYNCHRONIZED_UPDATE } from "@bigbud/shared/terminalSynchronizedOutput";

const SAMPLE_WINDOW = 240;
const MAX_PENDING_FRAMES = 256;
const RATE_WINDOW_MS = 1000;

export interface TerminalFrameMetricsSnapshot {
  /** Synchronized frames (DEC 2026 end markers) received by this view since mount. */
  readonly frames: number;
  /** Frames whose end marker arrived in the last second. */
  readonly framesPerSecond: number;
  /** Received-to-painted latency over the last frames, in milliseconds. */
  readonly latencyP50Ms: number | null;
  readonly latencyP95Ms: number | null;
  readonly latencyMaxMs: number | null;
  /** Frames received but not yet followed by an xterm render. */
  readonly unpaintedFrames: number;
  /** Frames dropped from tracking because no render followed (bounded queue). */
  readonly abandonedFrames: number;
}

function percentile(sorted: ReadonlyArray<number>, fraction: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return Math.round((sorted[Math.max(0, index)] ?? 0) * 10) / 10;
}

/**
 * Same metric as the O0 harness: a frame "arrives" when its synchronized-update end marker
 * reaches the view, and is "painted" at the next xterm render. Observes data only; never
 * holds a reference to output text beyond a marker-sized tail.
 */
export class TerminalFrameMetrics {
  private tail = "";
  private frames = 0;
  private abandoned = 0;
  private readonly pending: number[] = [];
  private readonly arrivals: number[] = [];
  private readonly latencies: number[] = [];

  constructor(private readonly now: () => number = () => performance.now()) {}

  observe(data: string): void {
    const text = this.tail + data;
    let count = 0;
    for (
      let index = text.indexOf(END_SYNCHRONIZED_UPDATE);
      index !== -1;
      index = text.indexOf(END_SYNCHRONIZED_UPDATE, index + END_SYNCHRONIZED_UPDATE.length)
    )
      count++;
    // Keep only enough characters to detect a marker split across chunks, never a whole marker.
    const keep = END_SYNCHRONIZED_UPDATE.length - 1;
    const lastMarker = text.lastIndexOf(END_SYNCHRONIZED_UPDATE);
    const tailStart = Math.max(
      text.length - keep,
      lastMarker === -1 ? 0 : lastMarker + END_SYNCHRONIZED_UPDATE.length,
    );
    this.tail = text.slice(tailStart);
    if (count === 0) return;
    const at = this.now();
    for (let frame = 0; frame < count; frame++) {
      this.frames++;
      this.arrivals.push(at);
      this.pending.push(at);
    }
    while (this.pending.length > MAX_PENDING_FRAMES) {
      this.pending.shift();
      this.abandoned++;
    }
    this.trimArrivals(at);
  }

  rendered(): void {
    if (this.pending.length === 0) return;
    const at = this.now();
    for (const arrival of this.pending) this.latencies.push(at - arrival);
    this.pending.length = 0;
    if (this.latencies.length > SAMPLE_WINDOW)
      this.latencies.splice(0, this.latencies.length - SAMPLE_WINDOW);
  }

  snapshot(): TerminalFrameMetricsSnapshot {
    this.trimArrivals(this.now());
    const sorted = this.latencies.toSorted((left, right) => left - right);
    return {
      frames: this.frames,
      framesPerSecond: this.arrivals.length,
      latencyP50Ms: percentile(sorted, 0.5),
      latencyP95Ms: percentile(sorted, 0.95),
      latencyMaxMs: percentile(sorted, 1),
      unpaintedFrames: this.pending.length,
      abandonedFrames: this.abandoned,
    };
  }

  private trimArrivals(at: number): void {
    let expired = 0;
    while (expired < this.arrivals.length && at - (this.arrivals[expired] ?? at) >= RATE_WINDOW_MS)
      expired++;
    if (expired > 0) this.arrivals.splice(0, expired);
  }
}
