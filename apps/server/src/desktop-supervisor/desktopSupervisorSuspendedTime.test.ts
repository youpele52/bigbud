import { Effect, Layer, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import { SystemSleepEpochs } from "../system-sleep/Services/SystemSleepEpochs.ts";
import { SystemSleepEpochsLive } from "../system-sleep/Layers/SystemSleepEpochs.ts";
import { startDesktopSupervisorHeartbeat } from "./desktopSupervisorDelivery.heartbeat.ts";
import type { DesktopSupervisorOwner } from "./desktopSupervisorDelivery.types.ts";
import { makeSupervisorSuspendedTimeObserver } from "./desktopSupervisorSuspendedTime.ts";

describe("supervisor suspended-time consumer", () => {
  it("does nothing without sleep epochs", async () => {
    expect(await Effect.runPromise(makeSupervisorSuspendedTimeObserver)).toBeNull();
  });

  it("opens a sleep epoch when suspended_millis jumps between heartbeat echoes", async () => {
    const latest = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* makeSupervisorSuspendedTimeObserver;
        expect(observer).not.toBeNull();
        observer!({ type: "heartbeat", value: { monotonicMillis: 5_000, suspendedMillis: 100 } });
        observer!({
          type: "heartbeat",
          value: { monotonicMillis: 10_000, suspendedMillis: 100 + 600_000 },
        });
        // An older supervisor without the field is ignored.
        observer!({ type: "heartbeat", value: { monotonicMillis: 15_000 } });
        yield* Effect.sleep(10);
        return yield* (yield* SystemSleepEpochs).latest;
      }).pipe(Effect.provide(Layer.fresh(SystemSleepEpochsLive))),
    );
    expect(Option.getOrUndefined(latest)).toMatchObject({
      durationMs: 600_000,
      sources: ["supervisor-clock"],
    });
  });

  it("forwards each heartbeat echo from the delivery heartbeat loop", async () => {
    vi.useFakeTimers();
    try {
      const echo = {
        type: "heartbeat" as const,
        value: { monotonicMillis: 1, suspendedMillis: 9 },
      };
      const client = { heartbeat: vi.fn(async () => echo) } as unknown as DesktopSupervisorOwner;
      const onEcho = vi.fn();
      const timer = startDesktopSupervisorHeartbeat({
        intervalMs: 1_000,
        getClient: () => client,
        isClosed: () => false,
        onFailure: () => undefined,
        onEcho,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      clearInterval(timer);
      expect(onEcho).toHaveBeenCalledWith(echo);
    } finally {
      vi.useRealTimers();
    }
  });
});
