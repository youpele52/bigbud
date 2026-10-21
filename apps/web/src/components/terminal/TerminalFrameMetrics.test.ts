import { describe, expect, it } from "vitest";
import {
  BEGIN_SYNCHRONIZED_UPDATE as BSU,
  END_SYNCHRONIZED_UPDATE as ESU,
} from "@bigbud/shared/terminalSynchronizedOutput";
import { TerminalFrameMetrics } from "./TerminalFrameMetrics";

function clocked() {
  let time = 0;
  const metrics = new TerminalFrameMetrics(() => time);
  return { metrics, advance: (ms: number) => (time += ms) };
}

describe("TerminalFrameMetrics", () => {
  it("measures end-marker arrival to the next render", () => {
    const { metrics, advance } = clocked();
    metrics.observe(`${BSU}a${ESU}${BSU}b${ESU}`);
    expect(metrics.snapshot().unpaintedFrames).toBe(2);
    advance(6);
    metrics.rendered();
    metrics.observe(`${BSU}c${ESU}`);
    advance(30);
    metrics.rendered();
    const snapshot = metrics.snapshot();
    expect(snapshot.frames).toBe(3);
    expect(snapshot.unpaintedFrames).toBe(0);
    expect(snapshot.latencyP50Ms).toBe(6);
    expect(snapshot.latencyMaxMs).toBe(30);
  });

  it("detects an end marker split across chunks exactly once", () => {
    const { metrics } = clocked();
    metrics.observe(`${BSU}body${ESU.slice(0, 3)}`);
    metrics.observe(`${ESU.slice(3)}plain`);
    metrics.observe("more plain");
    expect(metrics.snapshot().frames).toBe(1);
  });

  it("reports frames per second over a one-second window", () => {
    const { metrics, advance } = clocked();
    metrics.observe(frameRun(5));
    advance(600);
    metrics.observe(frameRun(3));
    expect(metrics.snapshot().framesPerSecond).toBe(8);
    advance(500);
    expect(metrics.snapshot().framesPerSecond).toBe(3);
  });

  it("bounds frames that never paint", () => {
    const { metrics } = clocked();
    metrics.observe(frameRun(300));
    const snapshot = metrics.snapshot();
    expect(snapshot.unpaintedFrames).toBe(256);
    expect(snapshot.abandonedFrames).toBe(44);
    expect(snapshot.latencyP50Ms).toBeNull();
  });
});

function frameRun(count: number): string {
  return Array.from({ length: count }, (_, index) => `${BSU}${index}${ESU}`).join("");
}
