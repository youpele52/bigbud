import { Deferred, Effect, Fiber } from "effect";
import { expect, it, vi } from "vitest";
import { TerminalAgentInspectionError } from "./Manager.agentDetection.ts";
import {
  scheduleRemoteTerminalInspection,
  REMOTE_IDENTITY_SAMPLE_MS,
} from "./Manager.remote-inspection.schedule.ts";

it("samples per target at an explicit cadence, not per pane or manager activity tick", async () => {
  let now = 0;
  const inspect = vi.fn(() => Effect.succeed([]));
  const scheduled = scheduleRemoteTerminalInspection(inspect, () => now);
  await Effect.runPromise(scheduled("a"));
  for (let i = 0; i < 20; i++) await Effect.runPromise(Effect.result(scheduled("a")));
  expect(inspect).toHaveBeenCalledTimes(1);
  await Effect.runPromise(scheduled("b"));
  expect(inspect).toHaveBeenCalledTimes(2);
  now = REMOTE_IDENTITY_SAMPLE_MS - 1;
  expect((await Effect.runPromise(Effect.result(scheduled("a"))))._tag).toBe("Failure");
  now++;
  await Effect.runPromise(scheduled("a"));
  expect(inspect).toHaveBeenCalledTimes(3);
});

it("backs transient and unsupported-target failures off independently, capped at 60 seconds, resetting after success", async () => {
  let now = 0;
  let fails = true;
  const inspect = vi.fn(() =>
    fails
      ? Effect.fail(new TerminalAgentInspectionError({ message: "unsupported or offline" }))
      : Effect.succeed([]),
  );
  const scheduled = scheduleRemoteTerminalInspection(inspect, () => now);
  for (const delay of [5000, 10000, 20000, 40000, 60000, 60000]) {
    const calls = inspect.mock.calls.length;
    await Effect.runPromise(Effect.result(scheduled("a")));
    expect(inspect).toHaveBeenCalledTimes(calls + 1);
    now += delay - 1;
    await Effect.runPromise(Effect.result(scheduled("a")));
    expect(inspect).toHaveBeenCalledTimes(calls + 1);
    now++;
  }
  fails = false;
  await Effect.runPromise(scheduled("a"));
  const calls = inspect.mock.calls.length;
  now += REMOTE_IDENTITY_SAMPLE_MS;
  await Effect.runPromise(scheduled("a"));
  expect(inspect).toHaveBeenCalledTimes(calls + 1);
});

it("never overlaps the same target and releases its running guard on interruption", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let now = 0;
      const started = yield* Deferred.make<void>();
      const inspect = vi.fn(() =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const scheduled = scheduleRemoteTerminalInspection(inspect, () => now);
      const first = yield* Effect.forkChild(scheduled("a"));
      yield* Deferred.await(started);
      now = 100000;
      expect((yield* Effect.result(scheduled("a")))._tag).toBe("Failure");
      expect(inspect).toHaveBeenCalledTimes(1);
      yield* Fiber.interrupt(first);
      now += 60001;
      const second = yield* Effect.forkChild(scheduled("a"));
      yield* Effect.yieldNow;
      expect(inspect).toHaveBeenCalledTimes(2);
      yield* Fiber.interrupt(second);
    }),
  );
});

it("bounds target bookkeeping without evicting active retry guards", async () => {
  let now = 0;
  const inspect = vi.fn(() => Effect.succeed([]));
  const scheduled = scheduleRemoteTerminalInspection(inspect, () => now);
  for (let i = 0; i < 256; i++) await Effect.runPromise(scheduled(String(i)));
  expect((await Effect.runPromise(Effect.result(scheduled("new"))))._tag).toBe("Failure");
  expect(inspect).toHaveBeenCalledTimes(256);
  now = 300001;
  await Effect.runPromise(scheduled("new"));
  expect(inspect).toHaveBeenCalledTimes(257);
});
