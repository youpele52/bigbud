import { ThreadId } from "@bigbud/contracts";
import { assert, it as effectIt } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { makeReadModelResidencySweeper } from "./ReadModelResidencySweeper.ts";

describe("ReadModelResidencySweeper", () => {
  it("holds threads with a live provider session or an active terminal", async () => {
    const held: Record<string, boolean> = {};
    const engine = {
      evictIdleThreads: ({
        isHeld,
      }: {
        readonly isHeld: (threadId: ThreadId) => Effect.Effect<boolean>;
      }) =>
        Effect.gen(function* () {
          for (const id of ["live", "terminal", "idle"]) {
            held[id] = yield* isHeld(ThreadId.makeUnsafe(id));
          }
          return { evicted: 1, resident: 2 };
        }),
    };
    const layer = Layer.mergeAll(
      Layer.succeed(OrchestrationEngineService, engine as never),
      Layer.succeed(ProviderService, {
        listSessions: () => Effect.succeed([{ threadId: "live" }]),
      } as never),
      Layer.succeed(TerminalManager, {
        hasActiveThread: (threadId: string) => Effect.succeed(threadId === "terminal"),
      } as never),
    );
    const sweeper = await Effect.runPromise(
      makeReadModelResidencySweeper().pipe(Effect.provide(layer)),
    );
    expect("sweep" in sweeper).toBe(true);
    if ("sweep" in sweeper) await Effect.runPromise(sweeper.sweep);
    expect(held).toEqual({ live: true, terminal: true, idle: false });
  });

  it("is inert when the engine cannot evict", async () => {
    const sweeper = await Effect.runPromise(
      makeReadModelResidencySweeper().pipe(
        Effect.provide(Layer.succeed(OrchestrationEngineService, {} as never)),
      ),
    );
    expect("sweep" in sweeper).toBe(false);
  });
});

// Live (Lima arm64): the sweeper logged every 120 s with a 60 s interval, because the spaced
// schedule repeated `sleep + sweep`. One sweep per interval is the documented period.
effectIt.effect("sweeps once per interval", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let sweeps = 0;
      const engine = {
        evictIdleThreads: () =>
          Effect.sync(() => {
            sweeps += 1;
            return { evicted: 0, resident: 0 };
          }),
      };
      const sweeper = yield* makeReadModelResidencySweeper({ intervalMs: 60_000 }).pipe(
        Effect.provide(Layer.succeed(OrchestrationEngineService, engine as never)),
      );
      yield* sweeper.start();
      for (const expected of [1, 2, 3]) {
        yield* TestClock.adjust("60 seconds");
        yield* Effect.yieldNow;
        assert.equal(sweeps, expected);
      }
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);
