import {
  CommandId,
  type OrchestrationReadModel,
  type ThreadId,
  type TurnId,
} from "@bigbud/contracts";
import type {
  ComputerUseActivitySnapshot,
  ComputerUseActivityTurn,
  ComputerUseStopResult,
} from "@bigbud/contracts/server/computerUseActivity.ts";
import { Effect, Option, Stream } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { COMPUTER_USE_STOPPED_BY_USER_MESSAGE } from "./computerUseAdmission.ts";
import {
  computerUseActivityKey,
  deriveComputerUseActivity,
  isComputerUseEntryRelevant,
  sameComputerUseActivity,
} from "./computerUseActivity.logic.ts";
import type {
  ComputerUseActivityEntry,
  ComputerUseActivityShape,
} from "./Services/ComputerUseActivity.ts";
import type { CuaDriverShape } from "./Services/CuaDriver.ts";

/** Re-derives lingering turns that expire without any other change. */
const LINGER_RECHECK_INTERVAL = "5 seconds";
/** One stuck command queue must not hold a Stop (or its feedback) back. */
const INTERRUPT_DISPATCH_TIMEOUT = "5 seconds";
const SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "thread.session-set",
  "thread.archived",
  "thread.deleted",
]);

type ReadModelThread = OrchestrationReadModel["threads"][number];
interface InterruptTarget {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
}

export interface ComputerUseControlDeps {
  readonly activity: ComputerUseActivityShape;
  readonly engine: Pick<
    OrchestrationEngineShape,
    "dispatch" | "getReadModel" | "streamDomainEvents"
  >;
  readonly driver: CuaDriverShape | null;
  readonly nowMs?: () => number;
}

const readActivity = Effect.fn("readComputerUseActivity")(function* (deps: ComputerUseControlDeps) {
  const readModel = yield* deps.engine.getReadModel();
  const nowMs = (deps.nowMs ?? Date.now)();
  yield* deps.activity.prune((entry) =>
    isComputerUseEntryRelevant(entry, readModel.threads, nowMs),
  );
  const entries = yield* deps.activity.entries;
  return {
    readModel,
    entries,
    snapshot: deriveComputerUseActivity(entries, readModel.threads, nowMs),
  };
});

/** Current snapshot first, then each change (registry, session state, linger expiry). */
export function makeComputerUseActivityStream(
  deps: ComputerUseControlDeps,
): Stream.Stream<ComputerUseActivitySnapshot> {
  const sessionChanges = deps.engine.streamDomainEvents.pipe(
    Stream.filter((event) => SESSION_EVENT_TYPES.has(event.type)),
    Stream.map(() => undefined),
  );
  return deps.activity.changes.pipe(
    Stream.map(() => undefined),
    Stream.merge(sessionChanges),
    Stream.merge(Stream.tick(LINGER_RECHECK_INTERVAL)),
    Stream.mapEffect(() => readActivity(deps).pipe(Effect.map(({ snapshot }) => snapshot))),
    Stream.changesWith(sameComputerUseActivity),
  );
}

const turnStartedAtMs = (thread: ReadModelThread, turnId: TurnId): number | null => {
  const latest = thread.latestTurn;
  if (latest?.turnId !== turnId) return null;
  const startedAt = Date.parse(latest.startedAt ?? latest.requestedAt);
  return Number.isFinite(startedAt) ? startedAt : null;
};

/**
 * The running turn to interrupt for an active entry: its own turn while the session still runs
 * it. An action recorded without a turn maps to the thread's running turn only when that turn
 * provably started no later than the action's last activity, so a newer, unrelated turn is never
 * interrupted. A turn that already ended (in flight or lingering) is left to the driver reset.
 */
function interruptTarget(
  turn: ComputerUseActivityTurn,
  entry: ComputerUseActivityEntry | undefined,
  readModel: OrchestrationReadModel,
): InterruptTarget | null {
  if (turn.turnId !== null) {
    return turn.turnRunning ? { threadId: turn.threadId, turnId: turn.turnId } : null;
  }
  const thread = readModel.threads.find((candidate) => candidate.id === turn.threadId);
  const activeTurnId = thread?.session?.activeTurnId;
  if (!thread || !activeTurnId || !entry) return null;
  const startedAtMs = turnStartedAtMs(thread, activeTurnId);
  return startedAtMs !== null && startedAtMs <= entry.lastActivityAtMs
    ? { threadId: turn.threadId, turnId: activeTurnId }
    : null;
}

const interruptTurn = Effect.fn("interruptComputerUseTurn")(function* (
  deps: ComputerUseControlDeps,
  readModel: OrchestrationReadModel,
  target: InterruptTarget,
) {
  const sessionEpoch = readModel.threads.find((thread) => thread.id === target.threadId)?.session
    ?.sessionEpoch;
  const dispatched = yield* deps.engine
    .dispatch({
      type: "thread.turn.interrupt",
      commandId: CommandId.makeUnsafe(`computer-use-stop:${crypto.randomUUID()}`),
      threadId: target.threadId,
      turnId: target.turnId,
      ...(sessionEpoch !== undefined ? { sessionEpoch } : {}),
      createdAt: new Date().toISOString(),
    })
    .pipe(
      Effect.timeoutOption(INTERRUPT_DISPATCH_TIMEOUT),
      Effect.map(Option.isSome),
      Effect.catchCause((cause) =>
        Effect.logWarning("computer use stop could not interrupt a turn", {
          threadId: target.threadId,
          turnId: target.turnId,
          cause,
        }).pipe(Effect.as(false)),
      ),
    );
  return { threadId: target.threadId, interrupted: dispatched };
});

const resetDriver = Effect.fn("resetComputerUseDriver")(function* (
  driver: CuaDriverShape | null,
  usedDesktop: boolean,
) {
  if (!usedDesktop) return { driverReset: "not-needed" as const, driverResetError: null };
  if (!driver?.stopAllActivity) {
    return { driverReset: "unavailable" as const, driverResetError: null };
  }
  return yield* driver.stopAllActivity(COMPUTER_USE_STOPPED_BY_USER_MESSAGE).pipe(
    Effect.map((outcome) => ({
      driverReset: outcome === "reset" ? ("reset" as const) : ("unavailable" as const),
      driverResetError: null,
    })),
    Effect.catch((error) =>
      Effect.succeed({ driverReset: "failed" as const, driverResetError: error.message }),
    ),
  );
});

const runStop = Effect.fn("stopComputerUse")(function* (deps: ComputerUseControlDeps) {
  const { readModel, entries, snapshot } = yield* readActivity(deps);
  if (!snapshot.active) {
    return {
      active: false,
      interruptedThreadIds: [],
      failedThreadIds: [],
      driverReset: "not-needed",
      driverResetError: null,
    } satisfies ComputerUseStopResult;
  }
  // Later actions of these turns fail before reaching either surface, and every admission issued
  // so far (an action waiting on the driver lock, or between two driver calls) turns stale.
  yield* deps.activity.markStopped(snapshot.turns);
  const entriesByKey = new Map(entries.map((entry) => [computerUseActivityKey(entry), entry]));
  const targets = new Map<ThreadId, InterruptTarget>();
  for (const turn of snapshot.turns) {
    const target = interruptTarget(turn, entriesByKey.get(computerUseActivityKey(turn)), readModel);
    if (target) targets.set(target.threadId, target);
  }
  // The driver halt does not depend on in-flight calls: a returned tool call may have left input
  // with the driver that interrupting the turn would not stop.
  const [driver, interrupts] = yield* Effect.all(
    [
      resetDriver(
        deps.driver,
        snapshot.turns.some((turn) => turn.usedDesktop),
      ),
      Effect.forEach([...targets.values()], (target) => interruptTurn(deps, readModel, target), {
        concurrency: "unbounded",
      }),
    ],
    { concurrency: "unbounded" },
  );
  return {
    active: true,
    interruptedThreadIds: interrupts.flatMap((entry) =>
      entry.interrupted ? [entry.threadId] : [],
    ),
    failedThreadIds: interrupts.flatMap((entry) => (entry.interrupted ? [] : [entry.threadId])),
    ...driver,
  } satisfies ComputerUseStopResult;
});

/**
 * Every press takes a fresh snapshot, so a turn that started computer use during an earlier
 * Stop is stopped too. Only the daemon restart is shared (inside the driver). A Stop runs to the
 * end even when its caller goes away.
 */
export function makeComputerUseStop(
  deps: ComputerUseControlDeps,
): Effect.Effect<ComputerUseStopResult> {
  return Effect.uninterruptible(Effect.suspend(() => runStop(deps)));
}
