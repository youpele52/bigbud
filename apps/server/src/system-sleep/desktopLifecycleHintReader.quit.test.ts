import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as NFS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { PassThrough } from "node:stream";

import { Effect, Fiber, Layer, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  AppQuitIntent,
  AppQuitIntentLive,
  makeAppQuitIntent,
  mergeAppQuitIntent,
} from "../lifecycle/AppQuitIntent.ts";
import { SystemSleepEpochsLive } from "./Layers/SystemSleepEpochs.ts";
import { SystemSleepEpochs } from "./Services/SystemSleepEpochs.ts";
import {
  consumeDesktopLifecycleHints,
  drainPendingHints,
  type HintSignalSource,
  parseDesktopLifecycleHintLine,
  writeDesktopLifecycleHintAck,
} from "./desktopLifecycleHintReader.ts";

const T0 = 1_761_140_000_000;
const line = (value: object) => `${JSON.stringify(value)}\n`;
const quitLine = (sequence: number, reason?: string) =>
  line({ kind: "quit", sequence, occurredAt: T0, online: true, ...(reason ? { reason } : {}) });

const TestLayer = Layer.mergeAll(SystemSleepEpochsLive, AppQuitIntentLive);
const run = <A, E>(effect: Effect.Effect<A, E, SystemSleepEpochs | AppQuitIntent>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestLayer)));

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("desktop quit hints", () => {
  it("parses quit lines with and without a reason", () => {
    expect(parseDesktopLifecycleHintLine(quitLine(2, "update"))).toMatchObject({
      kind: "quit",
      reason: "update",
    });
    expect(parseDesktopLifecycleHintLine(quitLine(2))).toMatchObject({ kind: "quit" });
    expect(parseDesktopLifecycleHintLine(quitLine(2, "reboot"))).toBeNull();
  });

  it("records the intent before acking it, and keeps feeding power hints to the epochs", async () => {
    const events: string[] = [];
    const result = await run(
      Effect.gen(function* () {
        const intent = yield* AppQuitIntent;
        const runSync = Effect.runSyncWith(yield* Effect.services<never>());
        const pipe = new PassThrough();
        pipe.write(line({ kind: "suspend", sequence: 1, occurredAt: T0, online: true }));
        pipe.write(quitLine(2, "update"));
        pipe.write(quitLine(2, "quit"));
        pipe.end(line({ kind: "resume", sequence: 3, occurredAt: T0 + 60_000, online: true }));
        yield* consumeDesktopLifecycleHints(pipe, {
          writeAck: (ack) => {
            const recorded = runSync(intent.resolve);
            events.push(`ack ${ack.sequence} after ${Option.getOrUndefined(recorded)?.reason}`);
            return true;
          },
        });
        const epochs = yield* SystemSleepEpochs;
        return { latest: yield* epochs.latest, intent: yield* intent.resolve };
      }),
    );
    // The duplicate sequence is acked again but keeps the first intent.
    expect(events).toEqual(["ack 2 after update", "ack 2 after update"]);
    expect(Option.getOrUndefined(result.intent)).toEqual({
      sequence: 2,
      reason: "update",
      occurredAt: T0,
    });
    expect(Option.getOrUndefined(result.latest)).toMatchObject({
      startedAtMs: T0,
      endedAtMs: T0 + 60_000,
    });
  });

  it("no quit hint means no intent, so the server detaches", async () => {
    const intent = await run(
      Effect.gen(function* () {
        const pipe = new PassThrough();
        pipe.end(line({ kind: "online", sequence: 1, occurredAt: T0, online: true }));
        yield* consumeDesktopLifecycleHints(pipe, { writeAck: () => true });
        return yield* (yield* AppQuitIntent).resolve;
      }),
    );
    expect(Option.isNone(intent)).toBe(true);
  });

  it("does not ack quit lines when no quit intent service is running", async () => {
    let acks = 0;
    await Effect.runPromise(
      Effect.gen(function* () {
        const pipe = new PassThrough();
        pipe.end(quitLine(1));
        yield* consumeDesktopLifecycleHints(pipe, { writeAck: () => (acks += 1) > 0 });
      }).pipe(Effect.provide(SystemSleepEpochsLive)),
    );
    expect(acks).toBe(0);
  });

  it.skipIf(process.platform === "win32")(
    "a SIGTERM 0 ms after the hint still sees the quit intent",
    async () => {
      const dir = NFS.mkdtempSync(Path.join(OS.tmpdir(), "bbqh-"));
      const fifo = Path.join(dir, "hints");
      execFileSync("mkfifo", [fifo]);
      const writer = NFS.openSync(fifo, NFS.constants.O_RDWR);
      const reader = NFS.openSync(fifo, NFS.constants.O_RDONLY | NFS.constants.O_NONBLOCK);
      cleanups.push(() => {
        NFS.closeSync(writer);
        NFS.closeSync(reader);
        NFS.rmSync(dir, { recursive: true, force: true });
      });
      const signals = new EventEmitter();
      const acks: number[] = [];
      const seen = await run(
        Effect.gen(function* () {
          const intent = yield* AppQuitIntent;
          const input = new PassThrough(); // Never delivers: only the synchronous drain reads.
          const fiber = yield* consumeDesktopLifecycleHints(input, {
            drainFd: reader,
            signals: signals as unknown as HintSignalSource,
            writeAck: (ack) => acks.push(ack.sequence) > 0,
          }).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          // Written and signalled in one synchronous turn: no event-loop read can happen, so
          // only the SIGTERM listener's synchronous drain can have recorded and acked it.
          NFS.writeSync(writer, quitLine(5, "quit"));
          signals.emit("SIGTERM");
          const acksAtSignal = [...acks];
          const atSignal = yield* intent.resolve;
          NFS.writeSync(writer, quitLine(6, "update"));
          drainPendingHints();
          const afterDrain = yield* intent.resolve;
          yield* Fiber.interrupt(fiber);
          expect(signals.listenerCount("SIGTERM")).toBe(0);
          return { acksAtSignal, atSignal, afterDrain };
        }),
      );
      expect(seen.acksAtSignal).toEqual([5]);
      expect(Option.getOrUndefined(seen.atSignal)?.sequence).toBe(5);
      expect(Option.getOrUndefined(seen.afterDrain)?.reason).toBe("update");
      expect(acks).toEqual([5, 6]);
    },
  );
});

describe("AppQuitIntent", () => {
  it("keeps the highest sequence and defaults the reason to quit", () => {
    const first = mergeAppQuitIntent(null, {
      kind: "quit",
      sequence: 4,
      occurredAt: 1,
      online: null,
    });
    expect(first).toEqual({ sequence: 4, reason: "quit", occurredAt: 1 });
    expect(
      mergeAppQuitIntent(first, {
        kind: "quit",
        sequence: 3,
        occurredAt: 2,
        online: null,
        reason: "update",
      }),
    ).toBe(first);
  });

  it("runs registered drains before resolving, and drops them with their scope", async () => {
    const service = makeAppQuitIntent();
    let drained = 0;
    await Effect.runPromise(Effect.scoped(service.registerDrain(() => (drained += 1))));
    await Effect.runPromise(service.resolve);
    expect(drained).toBe(0);
    await Effect.runPromise(
      Effect.scoped(
        service.registerDrain(() => (drained += 1)).pipe(Effect.andThen(service.resolve)),
      ),
    );
    expect(drained).toBe(1);
  });

  it("writes the ack record on the startup status fd", () => {
    const written: Array<[number, string]> = [];
    const write = (fd: number, text: string) => written.push([fd, text]);
    expect(
      writeDesktopLifecycleHintAck({ sequence: 7 }, { BIGBUD_STARTUP_STATUS_FD: "4" }, write),
    ).toBe(true);
    expect(written).toEqual([[4, '{"lifecycleHintAck":{"sequence":7}}\n']]);
    expect(writeDesktopLifecycleHintAck({ sequence: 7 }, {}, write)).toBe(false);
  });
});
