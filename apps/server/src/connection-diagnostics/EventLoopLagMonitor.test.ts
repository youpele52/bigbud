import { performance } from "node:perf_hooks";

import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ServerSpanActivity } from "../observability/Services/ServerSpanActivity.ts";
import { SystemSleepEpochsLive } from "../system-sleep/Layers/SystemSleepEpochs.ts";
import { SystemSleepEpochs } from "../system-sleep/Services/SystemSleepEpochs.ts";
import { SpanActivityTracker } from "../observability/SpanActivity.ts";
import {
  ServerLifecycleEvents,
  ServerLifecycleEventsLive,
} from "../startup/serverLifecycleEvents.ts";
import { makeConnectionDiagnostics } from "./Layers/ConnectionDiagnostics.ts";
import { makeEventLoopLagMonitor } from "./Layers/EventLoopLagMonitor.ts";
import { ConnectionDiagnostics } from "./Services/ConnectionDiagnostics.ts";

function blockEventLoop(durationMs: number): void {
  const until = Date.now() + durationMs;
  while (Date.now() < until) {
    // Intentionally synchronous: this is the stall under test.
  }
}

describe("makeEventLoopLagMonitor", () => {
  it("publishes a stalled lifecycle event with the span that was running", async () => {
    const diagnostics = makeConnectionDiagnostics();
    const spanActivity = new SpanActivityTracker();
    const layer = Layer.mergeAll(
      ServerLifecycleEventsLive,
      Layer.succeed(ConnectionDiagnostics, diagnostics),
      Layer.succeed(ServerSpanActivity, spanActivity),
    );

    const stalled = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lifecycleEvents = yield* ServerLifecycleEvents;
          yield* makeEventLoopLagMonitor({
            sampleIntervalMs: 25,
            windowMs: 100,
            thresholdMs: 300,
          });
          // Let the sampler take its first tick before stalling.
          yield* Effect.sleep(60);
          spanActivity.started("span-sql", "sql.execute", Date.now());
          blockEventLoop(600);
          spanActivity.ended("span-sql", Date.now());
          yield* Effect.sleep(200);
          const snapshot = yield* lifecycleEvents.snapshot;
          return snapshot.events.filter((event) => event.type === "stalled");
        }).pipe(Effect.provide(layer)),
      ),
    );

    expect(stalled).toHaveLength(1);
    const [event] = stalled;
    if (event?.type !== "stalled") throw new Error("expected a stalled event");
    expect(event.payload.durationMs).toBeGreaterThanOrEqual(300);
    expect(event.payload.durationMs).toBeLessThan(2_000);
    expect(event.payload.spans.map((span) => span.name)).toContain("sql.execute");

    const recorded = await Effect.runPromise(diagnostics.snapshot());
    expect(recorded.serverEvents.map((entry) => entry.type)).toEqual(["stalled"]);
    expect(recorded.eventLoop).not.toBeNull();
  });

  it("stays quiet on a healthy loop and stops when its scope closes", async () => {
    const diagnostics = makeConnectionDiagnostics();
    const layer = Layer.mergeAll(
      ServerLifecycleEventsLive,
      Layer.succeed(ConnectionDiagnostics, diagnostics),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* makeEventLoopLagMonitor({ sampleIntervalMs: 25, windowMs: 50, thresholdMs: 500 });
          yield* Effect.sleep(150);
        }).pipe(Effect.provide(layer)),
      ),
    );
    const afterClose = await Effect.runPromise(diagnostics.snapshot());
    expect(afterClose.serverEvents).toEqual([]);
    const lastWindow = afterClose.eventLoop;
    expect(lastWindow).not.toBeNull();

    await Effect.runPromise(Effect.sleep(150));
    expect((await Effect.runPromise(diagnostics.snapshot())).eventLoop).toBe(lastWindow);
  });

  it("records a Windows-style system sleep without publishing a stall or a window", async () => {
    const diagnostics = makeConnectionDiagnostics();
    const layer = Layer.mergeAll(
      ServerLifecycleEventsLive,
      Layer.succeed(ConnectionDiagnostics, diagnostics),
    );
    // Both clocks jump together and no CPU is spent, as when Windows wakes from sleep.
    let sleptMs = 0;
    const readClock = () => ({
      monotonicMs: performance.now() + sleptMs,
      wallMs: Date.now() + sleptMs,
      cpuMs: 0,
    });

    const stalled = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lifecycleEvents = yield* ServerLifecycleEvents;
          yield* makeEventLoopLagMonitor({
            sampleIntervalMs: 25,
            windowMs: 10_000,
            thresholdMs: 300,
            monotonicIncludesSleep: true,
            readClock,
          });
          yield* Effect.sleep(60);
          sleptMs = 120_000;
          yield* Effect.sleep(120);
          const snapshot = yield* lifecycleEvents.snapshot;
          return snapshot.events.filter((event) => event.type === "stalled");
        }).pipe(Effect.provide(layer)),
      ),
    );

    expect(stalled).toEqual([]);
    const recorded = await Effect.runPromise(diagnostics.snapshot());
    expect(recorded.serverEvents).toHaveLength(1);
    expect(recorded.serverEvents[0]).toMatchObject({ type: "suspected-system-sleep" });
    const [sleep] = recorded.serverEvents;
    if (sleep?.type !== "suspected-system-sleep") throw new Error("expected a suspected sleep");
    expect(sleep.durationMs).toBeGreaterThanOrEqual(119_000);
  });

  it("publishes a detected sleep to SystemSleepEpochs as server-gap evidence", async () => {
    const layer = Layer.mergeAll(
      ServerLifecycleEventsLive,
      Layer.succeed(ConnectionDiagnostics, makeConnectionDiagnostics()),
      SystemSleepEpochsLive,
    );
    let sleptMs = 0;
    const readClock = () => ({
      monotonicMs: performance.now() + sleptMs,
      wallMs: Date.now() + sleptMs,
      cpuMs: 0,
    });

    const epochs = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sleepEpochs = yield* SystemSleepEpochs;
          yield* makeEventLoopLagMonitor({
            sampleIntervalMs: 25,
            windowMs: 10_000,
            thresholdMs: 300,
            monotonicIncludesSleep: true,
            readClock,
          });
          yield* Effect.sleep(60);
          sleptMs = 120_000;
          yield* Effect.sleep(120);
          return yield* sleepEpochs.epochs;
        }).pipe(Effect.provide(layer)),
      ),
    );

    expect(epochs).toHaveLength(1);
    expect(epochs[0]?.sources).toEqual(["server-gap"]);
    expect(epochs[0]?.durationMs).toBeGreaterThanOrEqual(119_000);
  });
});
