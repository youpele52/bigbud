/**
 * Shared session stop for the ACP adapters (Cursor and Devin).
 *
 * Every step before the session's scope closes is bounded, so a hung cleanup (an orchestration
 * bridge promise, a notification fiber that will not die) can never keep the ACP agent alive: the
 * scope close is what SIGTERMs and, after `ACP_CHILD_FORCE_KILL_AFTER`, SIGKILLs it. A second stop
 * of a session already stopping (the adapter finalizer after a timed-out stop-all) waits, bounded,
 * for the first instead of skipping it.
 *
 * @module AcpSessionStop
 */
import type { EventId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { ProviderKind } from "@bigbud/contracts/orchestration/orchestration.provider";
import type { ProviderRuntimeEvent } from "@bigbud/contracts/orchestration/providerRuntime.events.ts";
import { Deferred, Duration, Effect, Exit, Fiber, Option, Scope } from "effect";

/** Bound for each of the (up to three) cleanup steps that run before the scope close. */
export const ACP_SESSION_CLEANUP_TIMEOUT = Duration.millis(500);
/**
 * How long a repeated stop (the adapter finalizer) waits for one in flight.
 *
 * Worst case for one stop: 3 × 500 ms of capped cleanup, then the scope close's bounded agent
 * release (`ACP_CHILD_FORCE_KILL_AFTER`, 2 s of SIGTERM, plus up to 1 s waiting after SIGKILL),
 * about 4.5 s in all. That exceeds the 3 s per-adapter stop-all timeout
 * (`PROVIDER_STOP_ALL_ADAPTER_TIMEOUT`), which only bounds how long stop-all waits; the stop keeps
 * running in its detached fiber. This wait bounds the finalizer instead and can return just before
 * the last SIGKILL wait ends.
 */
export const ACP_SESSION_STOP_WAIT = Duration.seconds(4);

export interface AcpStoppableSession {
  readonly threadId: ThreadId;
  readonly sessionEpoch: number;
  readonly scope: Scope.Closeable;
  readonly orchestrationBridgeCleanup?: () => Promise<void>;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  stopped: boolean;
}

export interface AcpSessionStopDeps<Session extends AcpStoppableSession> {
  readonly provider: ProviderKind;
  readonly sessions: Map<ThreadId, Session>;
  /** Resolve pending approvals and user-input requests so no caller waits on a dead session. */
  readonly settlePending: (session: Session) => Effect.Effect<void>;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly makeEventStamp: () => Effect.Effect<{
    readonly eventId: EventId;
    readonly createdAt: string;
  }>;
}

type CleanupStep = "settlePending" | "notificationFiber" | "orchestrationBridgeCleanup";

export function makeAcpSessionStop<Session extends AcpStoppableSession>(
  deps: AcpSessionStopDeps<Session>,
): (session: Session) => Effect.Effect<void> {
  const inFlight = new WeakMap<Session, Deferred.Deferred<void>>();

  const boundedCleanup = Effect.fn("AcpSessionStop.boundedCleanup")(function* <A, E>(
    session: Session,
    step: CleanupStep,
    cleanup: Effect.Effect<A, E>,
  ) {
    // Interruptible so the bound holds when the stop runs inside an uninterruptible finalizer.
    const finished = yield* Effect.interruptible(Effect.ignore(cleanup)).pipe(
      Effect.timeoutOption(ACP_SESSION_CLEANUP_TIMEOUT),
    );
    if (Option.isSome(finished)) return;
    yield* Effect.logWarning("ACP session cleanup step timed out; stopping the agent anyway", {
      provider: deps.provider,
      threadId: session.threadId,
      step,
      timeoutMs: Duration.toMillis(ACP_SESSION_CLEANUP_TIMEOUT),
    });
  });

  const stopOnce = Effect.fn("AcpSessionStop.stopOnce")(function* (session: Session) {
    session.stopped = true;
    yield* boundedCleanup(session, "settlePending", deps.settlePending(session));
    const notificationFiber = session.notificationFiber;
    if (notificationFiber)
      yield* boundedCleanup(session, "notificationFiber", Fiber.interrupt(notificationFiber));
    const bridgeCleanup = session.orchestrationBridgeCleanup;
    if (bridgeCleanup)
      yield* boundedCleanup(
        session,
        "orchestrationBridgeCleanup",
        Effect.tryPromise(() => bridgeCleanup()),
      );
    yield* Effect.ignore(Scope.close(session.scope, Exit.void));
    deps.sessions.delete(session.threadId);
    yield* deps.offerRuntimeEvent({
      type: "session.exited",
      ...(yield* deps.makeEventStamp()),
      sessionEpoch: session.sessionEpoch,
      provider: deps.provider,
      threadId: session.threadId,
      payload: { exitKind: "graceful" },
    });
  });

  return Effect.fn("AcpSessionStop.stop")(function* (session: Session) {
    const running = inFlight.get(session);
    if (running) {
      yield* Deferred.await(running).pipe(Effect.timeout(ACP_SESSION_STOP_WAIT), Effect.ignore);
      return;
    }
    // Stopped some other way (never through this stop): nothing left to release.
    if (session.stopped) return;
    const done = yield* Deferred.make<void>();
    inFlight.set(session, done);
    yield* stopOnce(session).pipe(Effect.ensuring(Deferred.succeed(done, undefined)));
  });
}
