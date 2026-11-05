/**
 * Bounded teardown for ACP agent processes (Cursor `agent acp`, Devin).
 *
 * Effect's Node spawner (4.0.0-beta.43) applies `forceKillAfter` only to delivering the first
 * signal, then waits for the exit without limit, so an agent that ignores SIGTERM stalls its
 * session's scope close and with it provider stop-all. This release escalates to SIGKILL itself.
 * Signals go to the agent's process group (the spawner defaults to `detached: true` on POSIX), so
 * Cursor's `worker-server` grandchild is included; Windows uses `taskkill /T /F`.
 *
 * @module AcpChildProcessRelease
 */
import { Clock, Duration, Effect, Fiber, Scope } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";

import { processGroupAlive, signalProcessGroup } from "../../utils/processGroup.ts";

/** SIGTERM-to-SIGKILL window for one ACP agent. Must stay below the per-adapter stop-all timeout. */
export const ACP_CHILD_FORCE_KILL_AFTER = Duration.seconds(2);
/** Upper bound on waiting for the exit after SIGKILL (an exit the OS should report at once). */
const SIGKILL_EXIT_WAIT = Duration.seconds(1);
/** Bound on waiting for a SIGKILLed group to clear (members exit at once; init reaps them). */
const GROUP_SIGKILL_CLEAR_WAIT = Duration.millis(500);
const GROUP_POLL = Duration.millis(50);

/**
 * The leader can exit on SIGTERM while a group member (Cursor's `worker-server`) ignores it. Give the
 * group the rest of the window, then SIGKILL whatever is left and wait (bounded) for it to clear.
 * POSIX only: Windows already ended the tree with `taskkill /T /F`. Called right after the leader's
 * exit, while its group can only still hold its own members (a PGID is not reused while it has any).
 */
const reapGroupWithin = Effect.fn("reapAcpProcessGroupWithin")(function* (
  pgid: number,
  remainingMs: number,
) {
  if (process.platform === "win32") return;
  const pollMs = Duration.toMillis(GROUP_POLL);
  for (let waited = 0; processGroupAlive(pgid) && waited < remainingMs; waited += pollMs) {
    yield* Effect.sleep(GROUP_POLL);
  }
  if (!processGroupAlive(pgid)) return;
  yield* Effect.logWarning("ACP agent group outlived its leader; sending SIGKILL", { pgid });
  signalProcessGroup(pgid, "SIGKILL");
  const exitWaitMs = Duration.toMillis(GROUP_SIGKILL_CLEAR_WAIT);
  for (let waited = 0; processGroupAlive(pgid) && waited < exitWaitMs; waited += pollMs) {
    yield* Effect.sleep(GROUP_POLL);
  }
});

export const releaseChildProcessWithin = Effect.fn("releaseChildProcessWithin")(function* (
  child: ChildProcessSpawner.ChildProcessHandle,
  forceKillAfter: Duration.Input,
) {
  // A leader that already exited is left alone: once its group may have emptied, the PGID could
  // name an unrelated new group, and stdio MCP servers exit on their own at stdin EOF.
  if (!(yield* child.isRunning.pipe(Effect.orElseSucceed(() => false)))) return;
  const pgid = Number(child.pid);
  const budgetMs = Duration.toMillis(Duration.fromInputUnsafe(forceKillAfter));
  const startedAt = yield* Clock.currentTimeMillis;
  // Interruptible so the timeouts hold even when the scope is closed from an uninterruptible
  // region, such as layer teardown at server shutdown.
  yield* Effect.interruptible(
    child.kill().pipe(
      Effect.timeout(forceKillAfter),
      Effect.catch(() =>
        Effect.logWarning("ACP agent ignored SIGTERM; sending SIGKILL", { pid: child.pid }).pipe(
          Effect.andThen(child.kill({ killSignal: "SIGKILL" })),
          Effect.timeout(SIGKILL_EXIT_WAIT),
        ),
      ),
      Effect.ignore,
      Effect.andThen(
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => reapGroupWithin(pgid, Math.max(0, budgetMs - (now - startedAt)))),
        ),
      ),
    ),
  );
});

/**
 * Register the bounded release on `scope`. Call it right after spawning into the same scope:
 * finalizers run in reverse order, so this runs before the spawner's own release, which then finds
 * the agent already gone. `afterRelease` (such as dropping the agent's process ledger record) runs
 * once the release has finished, however it ended.
 *
 * The release runs in a fresh fiber that the finalizer awaits. A scope closed because its fiber was
 * interrupted (a timeout, an interrupted caller) runs its finalizers in that interrupted fiber,
 * where the `Effect.interruptible` region above would abort at once and skip the escalation. The
 * release is bounded, so the wait is too.
 */
export const addBoundedChildRelease = (
  scope: Scope.Scope,
  child: ChildProcessSpawner.ChildProcessHandle,
  forceKillAfter: Duration.Input = ACP_CHILD_FORCE_KILL_AFTER,
  afterRelease: Effect.Effect<void> = Effect.void,
) =>
  Scope.addFinalizer(
    scope,
    Effect.forkDetach(
      releaseChildProcessWithin(child, forceKillAfter).pipe(Effect.ensuring(afterRelease)),
    ).pipe(Effect.flatMap(Fiber.await), Effect.asVoid),
  );
