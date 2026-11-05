import type { ThreadId, TurnId } from "@bigbud/contracts";
import { Data, ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

export class ComputerUseStoppedError extends Data.TaggedError("ComputerUseStoppedError")<{
  readonly message: string;
}> {}

export interface ComputerUseActivityKey {
  readonly threadId: ThreadId;
  /** The session's active turn when the action started; null when none was reported. */
  readonly turnId: TurnId | null;
}

export interface ComputerUseActivityAction extends ComputerUseActivityKey {
  readonly surface: "browser" | "desktop";
}

export interface ComputerUseActivityEntry extends ComputerUseActivityKey {
  readonly actionsInFlight: number;
  /** Any action of this turn used the desktop surface (and so the Cua driver). */
  readonly usedDesktop: boolean;
  /** Wall clock of the latest start or finish of an action of this turn. */
  readonly lastActivityAtMs: number;
  /** Wall clock of the last finished action, or null while only in-flight actions exist. */
  readonly lastEndedAtMs: number | null;
  /** The user stopped this turn's computer use; only its in-flight actions still count. */
  readonly stopped: boolean;
}

/**
 * In-memory registry of computer-use actions per thread turn (both surfaces). It only records
 * facts; whether a turn is still "using computer use" is derived against the session state in
 * `computerUseActivity.logic.ts`.
 */
export interface ComputerUseActivityShape {
  /**
   * Runs one action under the registry; fails without running when this turn was stopped. The
   * action runs with a `ComputerUseAdmission` that turns stale at the next Stop.
   */
  readonly track: <A, E, R>(
    action: ComputerUseActivityAction,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ComputerUseStoppedError, R>;
  readonly entries: Effect.Effect<ReadonlyArray<ComputerUseActivityEntry>>;
  /**
   * Blocks later actions of these turns, drops them from the active set once idle, and makes
   * every admission issued so far stale.
   */
  readonly markStopped: (keys: ReadonlyArray<ComputerUseActivityKey>) => Effect.Effect<void>;
  /** Removes idle entries that `keep` rejects (bounded memory). */
  readonly prune: (keep: (entry: ComputerUseActivityEntry) => boolean) => Effect.Effect<void>;
  /** Emits the current entries, then every change. */
  readonly changes: Stream.Stream<ReadonlyArray<ComputerUseActivityEntry>>;
}

export class ComputerUseActivity extends ServiceMap.Service<
  ComputerUseActivity,
  ComputerUseActivityShape
>()("t3/computer-use/Services/ComputerUseActivity") {}
