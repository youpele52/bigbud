/**
 * Keeps provider runtime rows and open tasks honest, so thread retention and worktree safety
 * see only real work.
 *
 * - After the startup reconciliation's session probe: provider runtime rows still marked
 *   `starting`/`running` with no live adapter session in this process become `stopped` (resume
 *   cursor kept, provider lease removed), and stale open tasks are marked stopped.
 * - When a turn ends (or the session exits) and the thread has no live session: the same
 *   reconcile for that thread, and its stale open tasks are marked stopped.
 *
 * Every step is best effort: a failure is logged and never blocks ingestion.
 *
 * @module ProviderRuntimeIngestion.runtimeHygiene
 */
import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { Cause, Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import type {
  ProviderServiceShape,
  ProviderSessionDiscoveryResult,
} from "../../provider/Services/ProviderService.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { settleStaleThreadTasks } from "./ProviderRuntimeIngestion.staleTasks.ts";

const TURN_END_EVENT_TYPES = new Set(["turn.completed", "turn.aborted", "session.exited"]);

const logFailure =
  (message: string, threadId?: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A | void, never, R> =>
    self.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning(message, {
              ...(threadId !== undefined ? { threadId } : {}),
              cause: Cause.pretty(cause),
            }),
      ),
    );

export const makeProviderRuntimeHygiene = Effect.fn("makeProviderRuntimeHygiene")(function* (deps: {
  readonly orchestrationEngine: Pick<OrchestrationEngineShape, "dispatch">;
  readonly providerService: Pick<ProviderServiceShape, "listSessions">;
}) {
  const repository = yield* Effect.serviceOption(ProviderSessionRuntimeRepository);
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const reconcileStale = Option.flatMap(repository, (value) =>
    Option.fromNullishOr(value.reconcileStale),
  );
  const settleTasks = (threadId?: string) =>
    Option.isSome(sql)
      ? settleStaleThreadTasks(
          { sql: sql.value, orchestrationEngine: deps.orchestrationEngine },
          threadId !== undefined ? { threadId } : {},
        )
      : Effect.succeed(0);

  /** `observedBefore` must be taken before the probe listed the sessions. */
  const afterStartupProbe = (input: {
    readonly observedBefore: string;
    readonly discovery: Pick<ProviderSessionDiscoveryResult, "sessions" | "unavailableProviders">;
  }) =>
    Effect.gen(function* () {
      if (Option.isSome(reconcileStale)) {
        const stopped = yield* reconcileStale.value({
          liveThreadIds: input.discovery.sessions.map((session) => session.threadId),
          unavailableProviders: [...input.discovery.unavailableProviders],
          observedBefore: input.observedBefore,
          reconciledAt: new Date().toISOString(),
        });
        if (stopped > 0) {
          yield* Effect.logInfo("stale provider runtime rows marked stopped at startup", {
            stoppedCount: stopped,
          });
        }
      }
      const settled = yield* settleTasks();
      if (settled > 0) {
        yield* Effect.logInfo("stale open tasks marked stopped at startup", { settled });
      }
    }).pipe(logFailure("provider runtime hygiene failed at startup"));

  const afterRuntimeEvent = (event: ProviderRuntimeEvent) =>
    TURN_END_EVENT_TYPES.has(event.type)
      ? Effect.gen(function* () {
          const threadId = String(event.threadId);
          const observedBefore = new Date().toISOString();
          const live = yield* deps.providerService.listSessions();
          if (live.some((session) => session.threadId === event.threadId)) {
            yield* settleTasks(threadId);
            return;
          }
          if (Option.isSome(reconcileStale)) {
            yield* reconcileStale.value({
              liveThreadIds: [],
              unavailableProviders: [],
              observedBefore,
              reconciledAt: new Date().toISOString(),
              threadIds: [threadId],
            });
          }
          yield* settleTasks(threadId);
        }).pipe(logFailure("provider runtime hygiene failed after a turn ended", event.threadId))
      : Effect.void;

  return { afterStartupProbe, afterRuntimeEvent };
});
