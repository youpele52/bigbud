import { ThreadId } from "@bigbud/contracts";
import { Effect, Layer } from "effect";
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
