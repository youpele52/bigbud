import { Deferred, Effect, Exit, Fiber } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { toPersistenceSqlError } from "../persistence/Errors.ts";
import type { WsRpcContext } from "./wsRpcContext.ts";
import { makeWsRpcUsageHandlers } from "./wsRpcHandlers.usage.ts";

function makeContext() {
  const getUsageEntries = vi.fn(() => Effect.succeed([]));
  const getUsageActiveDays = vi.fn(() => Effect.succeed([] as string[]));
  return {
    projectionSnapshotQuery: {
      getUsageEntries,
      getUsageHistoryStatus: () => Effect.succeed("ready"),
      getUsageActiveDays,
    },
  } as unknown as WsRpcContext;
}

afterEach(() => vi.useRealTimers());

it("shares in-flight work and reopen results across handlers, but separates ranges", async () => {
  const context = makeContext();
  let calls = 0;
  await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      vi.spyOn(context.projectionSnapshotQuery, "getUsageEntries").mockImplementation(() =>
        Effect.gen(function* () {
          calls++;
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return [];
        }),
      );
      const first = makeWsRpcUsageHandlers(context)["server.getUsageSummary"];
      const second = makeWsRpcUsageHandlers(context)["server.getUsageSummary"];
      const a = yield* Effect.forkChild(first({ range: "24h" }));
      yield* Deferred.await(entered);
      const b = yield* Effect.forkChild(second({ range: "24h" }));
      yield* Effect.yieldNow;
      expect(calls).toBe(1);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(a)).toEqual(yield* Fiber.join(b));
      yield* second({ range: "24h" });
      expect(calls).toBe(1);
      yield* second({ range: "7d" });
      expect(calls).toBe(2);
    }),
  );
});

it("does not cache failed requests", async () => {
  const context = makeContext();
  let calls = 0;
  vi.spyOn(context.projectionSnapshotQuery, "getUsageEntries").mockImplementation(() => {
    calls++;
    return calls === 1
      ? Effect.fail(toPersistenceSqlError("usage-test")(new Error("temporary failure")))
      : Effect.succeed([]);
  });
  const load = makeWsRpcUsageHandlers(context)["server.getUsageSummary"];
  expect(Exit.isFailure(await Effect.runPromise(Effect.exit(load({ range: "all" }))))).toBe(true);
  await Effect.runPromise(load({ range: "all" }));
  expect(calls).toBe(2);
});

it("expires summaries within five seconds and never shares data across databases", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-06T12:00:00.000Z"));
  const context = makeContext();
  const entries = vi.spyOn(context.projectionSnapshotQuery, "getUsageEntries");
  const load = makeWsRpcUsageHandlers(context)["server.getUsageSummary"];
  await Effect.runPromise(load({ range: "all" }));
  await Effect.runPromise(load({ range: "all" }));
  expect(entries).toHaveBeenCalledTimes(1);
  vi.setSystemTime(new Date("2026-11-06T12:00:05.001Z"));
  await Effect.runPromise(load({ range: "all" }));
  expect(entries).toHaveBeenCalledTimes(2);
  const other = makeContext();
  const otherEntries = vi.spyOn(other.projectionSnapshotQuery, "getUsageEntries");
  await Effect.runPromise(
    makeWsRpcUsageHandlers(other)["server.getUsageSummary"]({ range: "all" }),
  );
  expect(otherEntries).toHaveBeenCalledTimes(1);
});

it("does not reuse yesterday's streak after midnight", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-06T23:59:59.500Z"));
  const context = makeContext();
  const days = vi.spyOn(context.projectionSnapshotQuery, "getUsageActiveDays");
  days.mockReturnValue(Effect.succeed(["2026-11-06"]));
  const load = makeWsRpcUsageHandlers(context)["server.getUsageSummary"];
  expect((await Effect.runPromise(load({ range: "all" }))).streakDays).toBe(1);
  vi.setSystemTime(new Date("2026-11-07T00:00:00.001Z"));
  expect((await Effect.runPromise(load({ range: "all" }))).streakDays).toBe(0);
  expect(days).toHaveBeenCalledTimes(2);
});
