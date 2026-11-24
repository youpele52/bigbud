/**
 * Discards working tree changes for files the user saw in the Git panel. Every git invocation is
 * an argv array with literal, repository-root pathspecs after `--`; nothing runs through a shell.
 *
 * @module GitStatus.discard
 */
import { Effect, type Path } from "effect";
import type { GitCommandError } from "@bigbud/contracts";

import type { WorkspaceTrash } from "../../workspace/Layers/WorkspaceTrash.ts";
import type { GitDiscardSelection } from "../Services/GitCore.ts";
import { gitMutationOperationId, type GitHelpers } from "./GitCoreExecutor.ts";
import { createGitCommandError } from "./GitCoreUtils.ts";
import {
  parsePorcelainV2Z,
  planGitDiscard,
  toLiteralTopPathspec,
} from "./GitStatus.discard.logic.ts";

const OPERATION = "GitCore.discardChanges";
const PATHS_PER_COMMAND = 200;

function chunk<T>(values: ReadonlyArray<T>): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += PATHS_PER_COMMAND) {
    chunks.push(values.slice(index, index + PATHS_PER_COMMAND));
  }
  return chunks;
}

export interface MakeDiscardSelectedChangesInput {
  readonly executeGit: GitHelpers["executeGit"];
  readonly path: Path.Path;
  /** Paths the Git panel lists for `cwd`, read the same way as status. */
  readonly readListedPaths: (cwd: string) => Effect.Effect<ReadonlyArray<string>, GitCommandError>;
  /** Local repositories only: untracked files go to the Trash when it is available. */
  readonly trash: WorkspaceTrash | undefined;
}

export function makeDiscardSelectedChanges(input: MakeDiscardSelectedChangesInput) {
  const { executeGit, path, readListedPaths, trash } = input;

  const moveUntrackedToTrash = Effect.fn("moveUntrackedToTrash")(function* (
    cwd: string,
    activeTrash: WorkspaceTrash,
    files: ReadonlyArray<string>,
  ) {
    const topLevelArgs = ["rev-parse", "--show-toplevel"];
    const topLevel = (yield* executeGit(`${OPERATION}.topLevel`, cwd, topLevelArgs)).stdout.trim();
    for (const relativePath of files) {
      const absolutePath = path.resolve(topLevel, relativePath);
      const relation = path.relative(topLevel, absolutePath);
      if (relation.length === 0 || relation.startsWith("..") || path.isAbsolute(relation)) {
        return yield* createGitCommandError(
          OPERATION,
          cwd,
          topLevelArgs,
          `Refusing to remove a path outside the repository: ${relativePath}`,
        );
      }
      yield* Effect.tryPromise({
        try: () => activeTrash.moveToTrash(absolutePath),
        catch: (cause) =>
          createGitCommandError(
            OPERATION,
            cwd,
            ["trash", relativePath],
            cause instanceof Error ? cause.message : "Moving to the Trash failed.",
            cause,
          ),
      });
    }
  });

  return Effect.fn("discardSelectedChanges")(function* (
    cwd: string,
    selection: GitDiscardSelection,
    operationId: string | undefined,
  ) {
    const listedPaths = yield* readListedPaths(cwd);
    const statusArgs = ["status", "--porcelain=2", "-z", "-uall"];
    const statusResult = yield* executeGit(`${OPERATION}.status`, cwd, statusArgs);
    const plan = planGitDiscard({
      selection,
      listedPaths,
      entries: parsePorcelainV2Z(statusResult.stdout),
    });
    if (!plan.ok) {
      return yield* createGitCommandError(OPERATION, cwd, statusArgs, plan.detail);
    }

    for (const [index, paths] of chunk(plan.tracked).entries()) {
      yield* executeGit(
        `${OPERATION}.restore`,
        cwd,
        [
          "restore",
          "--source=HEAD",
          "--staged",
          "--worktree",
          "--",
          ...paths.map(toLiteralTopPathspec),
        ],
        {
          timeoutMs: 30_000,
          fallbackErrorMessage: "Failed to restore files to HEAD",
          operationId: gitMutationOperationId(operationId, `discard.restore.${index}`),
        },
      );
    }

    if (plan.untracked.length === 0) return;
    if (trash?.available) {
      return yield* moveUntrackedToTrash(cwd, trash, plan.untracked);
    }
    for (const [index, paths] of chunk(plan.untracked).entries()) {
      yield* executeGit(
        `${OPERATION}.clean`,
        cwd,
        ["clean", "-f", "-q", "--", ...paths.map(toLiteralTopPathspec)],
        {
          timeoutMs: 30_000,
          fallbackErrorMessage: "Failed to remove untracked files",
          operationId: gitMutationOperationId(operationId, `discard.clean.${index}`),
        },
      );
    }
  });
}
