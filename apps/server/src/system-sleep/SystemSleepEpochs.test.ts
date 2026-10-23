import { PassThrough } from "node:stream";

import { Effect, Fiber, Option, type Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { SystemSleepEpochs } from "./Services/SystemSleepEpochs.ts";
import { SystemSleepEpochsLive } from "./Layers/SystemSleepEpochs.ts";
import {
  consumeDesktopLifecycleHints,
  parseDesktopLifecycleHintLine,
} from "./desktopLifecycleHintReader.ts";

const T0 = 1_761_140_000_000;

const run = <A, E>(effect: Effect.Effect<A, E, SystemSleepEpochs | Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(SystemSleepEpochsLive))));

describe("SystemSleepEpochs", () => {
  it("publishes epoch-ended once per sleep and network-online from hints", async () => {
    const events = await run(
      Effect.gen(function* () {
        const epochs = yield* SystemSleepEpochs;
        const collector = yield* Stream.runCollect(Stream.take(epochs.events, 2)).pipe(
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* epochs.recordDesktopHint({
          kind: "suspend",
          sequence: 1,
          occurredAt: T0,
          online: true,
        });
        yield* epochs.recordDesktopHint({
          kind: "resume",
          sequence: 2,
          occurredAt: T0 + 600_000,
          online: false,
        });
        // The gap detector's report of the same sleep merges silently.
        yield* epochs.recordEvidence({
          source: "server-gap",
          startedAtMs: T0 + 1_000,
          endedAtMs: T0 + 600_250,
        });
        yield* epochs.recordDesktopHint({
          kind: "online",
          sequence: 3,
          occurredAt: T0 + 605_000,
          online: true,
        });
        const collected = Array.from(yield* Fiber.join(collector));
        expect(yield* epochs.isWithinSleepWindow(T0 + 620_000)).toBe(true);
        expect(yield* epochs.isWithinSleepWindow(T0 + 700_000)).toBe(false);
        expect(yield* epochs.networkOnline).toBe(true);
        const latest = yield* epochs.latest;
        expect(Option.getOrUndefined(latest)?.sources).toEqual(["desktop-hint", "server-gap"]);
        return collected;
      }),
    );
    expect(events.map((event) => event.type)).toEqual(["epoch-ended", "network-online"]);
  });

  it("opens an epoch from the supervisor clock alone", async () => {
    const latest = await run(
      Effect.gen(function* () {
        const epochs = yield* SystemSleepEpochs;
        yield* epochs.recordSupervisorSuspendedMillis({ suspendedMillis: 5_000, observedAtMs: T0 });
        yield* epochs.recordSupervisorSuspendedMillis({
          suspendedMillis: 5_000 + 1_800_000,
          observedAtMs: T0 + 1_805_000,
        });
        return yield* epochs.latest;
      }),
    );
    expect(Option.getOrUndefined(latest)).toMatchObject({
      durationMs: 1_800_000,
      sources: ["supervisor-clock"],
    });
  });
});

describe("desktop lifecycle hint reader", () => {
  it("parses valid lines and rejects malformed ones", () => {
    expect(
      parseDesktopLifecycleHintLine('{"kind":"resume","sequence":1,"occurredAt":5,"online":null}'),
    ).toEqual({ kind: "resume", sequence: 1, occurredAt: 5, online: null });
    expect(parseDesktopLifecycleHintLine("not json")).toBeNull();
    expect(parseDesktopLifecycleHintLine('{"kind":"lock-screen","sequence":1}')).toBeNull();
    expect(parseDesktopLifecycleHintLine("")).toBeNull();
  });

  it("applies every line from the pipe until it closes", async () => {
    const latest = await run(
      Effect.gen(function* () {
        const pipe = new PassThrough();
        pipe.write(
          `${JSON.stringify({ kind: "suspend", sequence: 1, occurredAt: T0, online: true })}\n`,
        );
        pipe.write("garbage\n");
        pipe.end(
          `${JSON.stringify({ kind: "resume", sequence: 2, occurredAt: T0 + 60_000, online: true })}\n`,
        );
        yield* consumeDesktopLifecycleHints(pipe);
        const epochs = yield* SystemSleepEpochs;
        return yield* epochs.latest;
      }),
    );
    expect(Option.getOrUndefined(latest)).toMatchObject({
      startedAtMs: T0,
      endedAtMs: T0 + 60_000,
      sources: ["desktop-hint"],
    });
  });
});
