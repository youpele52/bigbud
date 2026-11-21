/**
 * AppQuitIntent - whether Electron main announced that it is quitting before it stops this
 * backend.
 *
 * Electron main writes a `quit` line on the fd 5 hint pipe and waits up to 1,500 ms for the
 * server's `DesktopLifecycleHintAck`. The fd 5 reader records the line here before it writes
 * the ack, so an acknowledged quit is always visible to the shutdown path. On SIGTERM the
 * shutdown path calls `resolve`, which first drains pending fd 5 lines synchronously: a SIGTERM
 * that arrives 0 ms after the hint still sees it.
 *
 * No intent (a standalone server, a CLI quit, an OS shutdown or logout, a crash, or an older
 * desktop) means detach: terminals keep running and the orphan policy applies.
 *
 * @module AppQuitIntent
 */
import type {
  DesktopQuitHint,
  DesktopQuitReason,
} from "@bigbud/contracts/server/desktopLifecycleHint.ts";
import { Effect, Layer, Option, ServiceMap } from "effect";
import type { Scope } from "effect";

export interface AppQuitIntentRecord {
  /** The hint line's sequence within this backend's lifetime. */
  readonly sequence: number;
  /** A line without a reason is an ordinary user quit. */
  readonly reason: DesktopQuitReason;
  /** Electron main's wall clock when it decided to quit, in epoch milliseconds. */
  readonly occurredAt: number;
}

export interface AppQuitIntentShape {
  /** Records one quit line; the line with the highest sequence wins. */
  readonly record: (hint: DesktopQuitHint) => Effect.Effect<void>;
  /** Registers a synchronous drain of pending hint input, removed when the scope closes. */
  readonly registerDrain: (drain: () => void) => Effect.Effect<void, never, Scope.Scope>;
  /** Drains pending hint input synchronously, then returns the intent. None means detach. */
  readonly resolve: Effect.Effect<Option.Option<AppQuitIntentRecord>>;
}

export class AppQuitIntent extends ServiceMap.Service<AppQuitIntent, AppQuitIntentShape>()(
  "bigbud/lifecycle/AppQuitIntent",
) {}

/** Applies one quit line; duplicate and out-of-order lines keep the current intent. */
export function mergeAppQuitIntent(
  current: AppQuitIntentRecord | null,
  hint: DesktopQuitHint,
): AppQuitIntentRecord {
  if (current !== null && hint.sequence <= current.sequence) return current;
  return { sequence: hint.sequence, reason: hint.reason ?? "quit", occurredAt: hint.occurredAt };
}

/**
 * Builds the service over plain synchronous state. Every member is an `Effect.sync`, so the
 * fd 5 reader can apply a line inside its data callback, before writing the ack.
 */
export function makeAppQuitIntent(): AppQuitIntentShape {
  let intent: AppQuitIntentRecord | null = null;
  const drains = new Set<() => void>();
  const runDrains = () => {
    for (const drain of drains) {
      try {
        drain();
      } catch {
        // A failed drain leaves the intent recorded so far; shutdown must still decide.
      }
    }
  };
  return {
    record: (hint) =>
      Effect.sync(() => {
        intent = mergeAppQuitIntent(intent, hint);
      }),
    registerDrain: (drain) =>
      Effect.acquireRelease(
        Effect.sync(() => drains.add(drain)),
        () => Effect.sync(() => drains.delete(drain)),
      ).pipe(Effect.asVoid),
    resolve: Effect.sync(() => {
      runDrains();
      return Option.fromNullishOr(intent);
    }),
  };
}

/** Logs the shutdown decision input last, after the fd 5 reader drained and closed. */
export const AppQuitIntentLive = Layer.effect(
  AppQuitIntent,
  Effect.gen(function* () {
    const service = makeAppQuitIntent();
    yield* Effect.addFinalizer(() =>
      service.resolve.pipe(
        Effect.flatMap((intent) =>
          Option.match(intent, {
            onNone: () => Effect.logInfo("backend stopping without a desktop quit intent"),
            onSome: (record) =>
              Effect.logInfo("backend stopping with a desktop quit intent", {
                reason: record.reason,
                sequence: record.sequence,
              }),
          }),
        ),
      ),
    );
    return service;
  }),
);
