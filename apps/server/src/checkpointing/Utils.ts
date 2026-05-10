import { Encoding } from "effect";
import { CheckpointRef, ProjectId, type ThreadId } from "@bigbud/contracts";

export const CHECKPOINT_REFS_PREFIX = "refs/bigbud/checkpoints";
export const LEGACY_CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";
export const CHECKPOINT_COMMIT_MESSAGE_PREFIX = "bigbud checkpoint";

function checkpointRefForThreadTurnWithPrefix(
  threadId: ThreadId,
  turnCount: number,
  prefix: string,
): CheckpointRef {
  return CheckpointRef.makeUnsafe(
    `${prefix}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`,
  );
}

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return checkpointRefForThreadTurnWithPrefix(threadId, turnCount, CHECKPOINT_REFS_PREFIX);
}

export function legacyCheckpointRefForThreadTurn(
  threadId: ThreadId,
  turnCount: number,
): CheckpointRef {
  return checkpointRefForThreadTurnWithPrefix(threadId, turnCount, LEGACY_CHECKPOINT_REFS_PREFIX);
}

export function checkpointRefCandidates(
  checkpointRef: CheckpointRef,
): ReadonlyArray<CheckpointRef> {
  const checkpointRefString = String(checkpointRef);

  if (checkpointRefString.startsWith(`${CHECKPOINT_REFS_PREFIX}/`)) {
    return [
      checkpointRef,
      CheckpointRef.makeUnsafe(
        checkpointRefString.replace(CHECKPOINT_REFS_PREFIX, LEGACY_CHECKPOINT_REFS_PREFIX),
      ),
    ];
  }

  if (checkpointRefString.startsWith(`${LEGACY_CHECKPOINT_REFS_PREFIX}/`)) {
    return [
      checkpointRef,
      CheckpointRef.makeUnsafe(
        checkpointRefString.replace(LEGACY_CHECKPOINT_REFS_PREFIX, CHECKPOINT_REFS_PREFIX),
      ),
    ];
  }

  return [checkpointRef];
}

export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string | null;
  }>;
}): string | undefined {
  const worktreeCwd = input.thread.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  return (
    input.projects.find((project) => project.id === input.thread.projectId)?.workspaceRoot ??
    undefined
  );
}
