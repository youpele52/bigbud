import { Duration, Effect, Option, Schedule } from "effect";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { READ_MODEL_EVICTION_SWEEP_INTERVAL_MS } from "./OrchestrationEngine.residency.ts";

/**
 * Periodically evicts idle threads from the engine read model (F-B4). Outside interest is
 * reported as holds: a thread with a live provider session (in this process) or an open
 * terminal is kept, whatever its projected state says.
 */
export const makeReadModelResidencySweeper = Effect.fn("makeReadModelResidencySweeper")(
  function* (options?: { readonly intervalMs?: number }) {
    // Optional so reactor tests need none of these; the server composition provides them all.
    const engine = yield* Effect.serviceOption(OrchestrationEngineService);
    const providerService = yield* Effect.serviceOption(ProviderService);
    const terminal = yield* Effect.serviceOption(TerminalManager);
    const evictIdleThreads = Option.isSome(engine) ? engine.value.evictIdleThreads : undefined;
    if (evictIdleThreads === undefined) return { start: () => Effect.void };

    const sweep = Effect.gen(function* () {
      const liveSessionThreadIds = new Set<string>(
        Option.isSome(providerService)
          ? (yield* providerService.value.listSessions()).map((session) => session.threadId)
          : [],
      );
      const hasActiveTerminal = Option.isSome(terminal)
        ? terminal.value.hasActiveThread
        : undefined;
      const result = yield* evictIdleThreads({
        isHeld: (threadId) =>
          liveSessionThreadIds.has(threadId)
            ? Effect.succeed(true)
            : hasActiveTerminal
              ? hasActiveTerminal(threadId)
              : Effect.succeed(false),
      });
      if (result.evicted > 0) {
        yield* Effect.logDebug("evicted idle threads from the orchestration read model", result);
      }
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("read-model sweep failed", { cause })));

    const interval = Duration.millis(options?.intervalMs ?? READ_MODEL_EVICTION_SWEEP_INTERVAL_MS);
    return {
      sweep,
      start: () =>
        Effect.forkScoped(
          Effect.sleep(interval).pipe(
            Effect.andThen(sweep),
            Effect.repeat(Schedule.spaced(interval)),
          ),
        ).pipe(Effect.asVoid),
    };
  },
);
