import { Effect, Fiber } from "effect";
import type { Scope } from "effect";
import { worktreeFailure } from "../git/Layers/WorktreeInventory.ts";

/** A transport disconnect stops waiting, not accepted work; server shutdown retains durable fences. */
export function runOwnedWorktreeOperation<A, E>(
  scope: Scope.Scope | undefined,
  operation: Effect.Effect<A, E>,
) {
  return Effect.gen(function* () {
    if (!scope)
      return yield* worktreeFailure(
        "worktree",
        "The long-lived workspace operation owner is unavailable. Nothing was dispatched.",
      );
    const fiber = yield* operation.pipe(Effect.forkIn(scope));
    return yield* Fiber.join(fiber);
  });
}
