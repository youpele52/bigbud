import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/**
 * `bigbud backend stop --for-upgrade` contract (W3.4). The command only runs the
 * W3.2 drain when it holds the backend lock; the drain itself writes the marker
 * and releases that lock as its last step. A refusal, cancel or failure returns
 * non-zero, writes no marker and releases nothing.
 *
 * @module cli.backend.drain
 */

export type BackendDrainRefusal =
  | "backend-running"
  | "cancelled"
  | "refused"
  | "failed"
  | "drain-hook-unavailable"
  | "consent-required"
  | "busy"
  | "unknown-artifact"
  | "timeout"
  | "offline-panes-unknown"
  | "unavailable";

export class BackendDrainError extends Data.TaggedError("BackendDrainError")<{
  readonly reason: BackendDrainRefusal;
  readonly message: string;
  readonly cause?: unknown;
}> {
  constructor(reason: BackendDrainRefusal, message: string, cause?: unknown) {
    super({ reason, message, cause });
  }
}

/** An offline drain is allowed only when the caller proves there are no live panes. */
export function planOfflineDrain(
  livePaneCount: number,
): { readonly kind: "drain" } | { readonly kind: "refuse"; readonly error: BackendDrainError } {
  if (!Number.isSafeInteger(livePaneCount) || livePaneCount < 0)
    return {
      kind: "refuse",
      error: new BackendDrainError("refused", "The live pane count is invalid."),
    };
  return livePaneCount === 0
    ? { kind: "drain" }
    : {
        kind: "refuse",
        error: new BackendDrainError(
          "offline-panes-unknown",
          `${livePaneCount} live pane${livePaneCount === 1 ? "" : "s"} may still exist; an offline drain is refused instead of guessing.`,
        ),
      };
}

export interface BackendLockLease {
  readonly release: () => Promise<void>;
}

/**
 * Acquires the offline backend lock, runs the drain, and returns only on a
 * committed drain. The drain owns the lock release on success; every failure
 * path leaves the lock exactly as it was.
 */
export const runBackendForUpgradeStop = Effect.fn("runBackendForUpgradeStop")(function* (input: {
  readonly acquireLock: Effect.Effect<BackendLockLease, BackendDrainError>;
  readonly drain: (
    lock: BackendLockLease,
  ) => Effect.Effect<"drained" | "cancelled", BackendDrainError>;
}) {
  const lock = yield* input.acquireLock;
  const outcome = yield* input.drain(lock);
  if (outcome === "cancelled")
    return yield* new BackendDrainError(
      "cancelled",
      "The upgrade was cancelled; the backend and its lock are unchanged.",
    );
  return "drained" as const;
});

/**
 * Followers cannot be silently abandoned: the coordinator drains them, or the
 * command refuses with this typed reason. There is no local fallback.
 */
export type FollowerDrainPlan =
  | { readonly kind: "drain-through-coordinator"; readonly followers: number }
  | { readonly kind: "refuse"; readonly error: BackendDrainError };

export async function requestFollowerDrain(
  followerCount: number,
  coordinator?: () => Promise<number>,
): Promise<FollowerDrainPlan> {
  if (followerCount === 0) return planFollowerDrain(0);
  if (!coordinator)
    return {
      kind: "refuse",
      error: new BackendDrainError(
        "drain-hook-unavailable",
        `${followerCount} peer follower${followerCount === 1 ? "" : "s"} cannot be drained by this build's coordinator; stop them explicitly before upgrading.`,
      ),
    };
  try {
    const drained = await coordinator();
    if (drained !== followerCount)
      return {
        kind: "refuse",
        error: new BackendDrainError(
          "refused",
          `The coordinator drained ${drained} of ${followerCount} followers; followers were not abandoned.`,
        ),
      };
    return { kind: "drain-through-coordinator", followers: followerCount };
  } catch (cause) {
    return {
      kind: "refuse",
      error: new BackendDrainError(
        "unavailable",
        "The peer coordinator did not answer the follower drain; no follower was abandoned.",
        cause,
      ),
    };
  }
}

export function planFollowerDrain(followerCount: number): FollowerDrainPlan {
  if (followerCount < 0 || !Number.isSafeInteger(followerCount))
    return {
      kind: "refuse",
      error: new BackendDrainError("refused", "The peer follower count is invalid."),
    };
  return followerCount === 0
    ? { kind: "drain-through-coordinator", followers: 0 }
    : {
        kind: "refuse",
        error: new BackendDrainError(
          "drain-hook-unavailable",
          `${followerCount} peer follower${followerCount === 1 ? "" : "s"} cannot be drained by this build's coordinator; stop them explicitly before upgrading.`,
        ),
      };
}
