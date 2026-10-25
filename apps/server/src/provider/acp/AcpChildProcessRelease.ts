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
import { Clock, Duration, Effect, Scope } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";

/** SIGTERM-to-SIGKILL window for one ACP agent. Must stay below the per-adapter stop-all timeout. */
export const ACP_CHILD_FORCE_KILL_AFTER = Duration.seconds(2);
/** Upper bound on waiting for the exit after SIGKILL (an exit the OS should report at once). */
const SIGKILL_EXIT_WAIT = Duration.seconds(1);
const GROUP_POLL = Duration.millis(50);

/** True while any process is left in the group (EPERM: the PGID now names someone else's). */
const groupAlive = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

const killGroup = (pgid: number) => {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    /* Already gone. */
  }
};

/**
 * The leader can exit on SIGTERM while a group member (Cursor's `worker-server`) ignores it. Give the
 * group the rest of the window, then SIGKILL whatever is left. POSIX only: Windows already ended the
 * tree with `taskkill /T /F`.
 */
const reapGroupWithin = Effect.fn("reapAcpProcessGroupWithin")(function* (
  pgid: number,
  remainingMs: number,
) {
  if (process.platform === "win32") return;
  for (let waited = 0; groupAlive(pgid) && waited < remainingMs; ) {
    yield* Effect.sleep(GROUP_POLL);
    waited += Duration.toMillis(GROUP_POLL);
  }
  if (!groupAlive(pgid)) return;
  yield* Effect.logWarning("ACP agent group outlived its leader; sending SIGKILL", { pgid });
  killGroup(pgid);
});

export const releaseChildProcessWithin = Effect.fn("releaseChildProcessWithin")(function* (
  child: ChildProcessSpawner.ChildProcessHandle,
  forceKillAfter: Duration.Input,
) {
  if (!(yield* child.isRunning.pipe(Effect.orElseSucceed(() => false)))) return;
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
          Effect.flatMap((now) =>
            reapGroupWithin(Number(child.pid), Math.max(0, budgetMs - (now - startedAt))),
          ),
        ),
      ),
    ),
  );
});

/**
 * Register the bounded release on `scope`. Call it right after spawning into the same scope:
 * finalizers run in reverse order, so this runs before the spawner's own release, which then finds
 * the agent already gone.
 */
export const addBoundedChildRelease = (
  scope: Scope.Scope,
  child: ChildProcessSpawner.ChildProcessHandle,
  forceKillAfter: Duration.Input = ACP_CHILD_FORCE_KILL_AFTER,
) => Scope.addFinalizer(scope, releaseChildProcessWithin(child, forceKillAfter));
