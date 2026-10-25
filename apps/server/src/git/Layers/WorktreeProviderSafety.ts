import { Effect } from "effect";
import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import { recordedWorktreePathsOverlap } from "../../deletion/Layers/ThreadDeletion.worktreePaths.ts";
import { canonicalWorktreePath } from "./WorktreeReferences.ts";
import { worktreeFailure } from "./WorktreeInventory.ts";

/** Read-only discovery runs outside the engine/SQL barrier; durable admissions prevent late starts. */
export function assertNoLiveWorktreeProvider(
  provider: Pick<ProviderServiceShape, "listSessionsForReconciliation"> | undefined,
  target: string,
) {
  if (!provider) return Effect.void;
  return Effect.gen(function* () {
    const discovery = yield* provider.listSessionsForReconciliation();
    if (!discovery.directoryAvailable || discovery.diagnostics.length)
      return yield* worktreeFailure(
        target,
        "Provider inactivity could not be established. No worktree mutation was attempted.",
      );
    for (const session of discovery.sessions) {
      const workspaceTarget =
        session.workspaceExecutionTargetId ?? session.executionTargetId ?? "local";
      if (workspaceTarget !== "local" || !session.cwd) continue;
      const cwd = yield* canonicalWorktreePath(session.cwd);
      if (recordedWorktreePathsOverlap(cwd, target))
        return yield* worktreeFailure(
          target,
          "A provider session still owns this worktree. Stop it explicitly before changing the folder.",
        );
    }
  });
}
