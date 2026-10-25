import { Effect, Fiber, type Scope } from "effect";
import { describe, expect, it } from "vitest";

import { SystemSleepEpochsLive } from "./Layers/SystemSleepEpochs.ts";
import { SystemSleepEpochs } from "./Services/SystemSleepEpochs.ts";
import { runRemoteAgentReattachWakeBridge } from "./remoteAgentReattachWakeBridge.ts";

const T0 = 1_761_140_000_000;

const run = <A, E>(effect: Effect.Effect<A, E, SystemSleepEpochs | Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(SystemSleepEpochsLive))));

describe("remote agent reattach wake bridge", () => {
  it("wakes reattach waiters on network-online and on each new sleep epoch", async () => {
    const wakes = await run(
      Effect.gen(function* () {
        let count = 0;
        const epochs = yield* SystemSleepEpochs;
        const bridge = yield* runRemoteAgentReattachWakeBridge(() => {
          count += 1;
        }).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* epochs.recordEvidence({
          source: "server-gap",
          startedAtMs: T0,
          endedAtMs: T0 + 600_000,
        });
        yield* epochs.recordDesktopHint({
          kind: "online",
          sequence: 1,
          occurredAt: T0 + 601_000,
          online: true,
        });
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(bridge);
        return count;
      }),
    );
    expect(wakes).toBe(2);
  });
});
