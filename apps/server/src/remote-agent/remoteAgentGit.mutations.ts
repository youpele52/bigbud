import { Effect, Option } from "effect";
import { GitCommandError } from "@bigbud/contracts/workspace/git.errors.ts";
import type { GitServiceError } from "@bigbud/contracts/workspace/git.errors.ts";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import { isLocalExecutionTarget } from "../executionTargets.ts";
import {
  RemoteAgentGitActionBinding,
  reserveRemoteAgentGitAction,
  completeRemoteAgentGitAction,
} from "./remoteAgentGit.action.ts";

interface MutationIdentity {
  readonly cwd: string;
  readonly executionTargetId?: string | undefined;
  readonly operationId?: string | undefined;
}

/** Every public multistep mutation owns one generation; nested stacked-action steps reuse theirs. */
export function bindRemoteGitMutations(git: GitCoreShape): GitCoreShape {
  const result = { ...git };
  const wrap = <K extends keyof GitCoreShape>(
    method: K,
    identify: (args: readonly unknown[]) => MutationIdentity,
  ) => {
    result[method] = ((...args: readonly unknown[]) => {
      const input = identify(args);
      const effect = (
        git[method] as (
          ...args: readonly unknown[]
        ) => Effect.Effect<unknown, GitCommandError | GitServiceError>
      )(...args);
      if (isLocalExecutionTarget(input.executionTargetId)) return effect;
      return Effect.gen(function* () {
        if (Option.isSome(yield* Effect.serviceOption(RemoteAgentGitActionBinding)))
          return yield* effect;
        const target = input.executionTargetId!;
        const id = input.operationId;
        const failure = (cause: unknown) =>
          new GitCommandError({
            operation: String(method),
            command: "git",
            cwd: input.cwd,
            detail:
              "Remote Git mutation requires its original durable action identity; no work was replayed.",
            cause,
          });
        if (!id) return yield* failure("Missing originating operation identity");
        const binding = yield* Effect.tryPromise({
          try: () => reserveRemoteAgentGitAction(target, id, { method, args }),
          catch: failure,
        });
        return yield* effect.pipe(
          Effect.provideService(RemoteAgentGitActionBinding, binding),
          Effect.tap(() => completeRemoteAgentGitAction(target, id)),
        );
      });
    }) as GitCoreShape[K];
  };
  for (const method of [
    "createWorktree",
    "removeWorktree",
    "fetchPullRequestBranch",
    "fetchRemoteBranch",
    "ensureRemote",
    "setBranchUpstream",
    "createBranch",
    "checkoutBranch",
    "renameBranch",
    "deleteBranch",
    "initRepo",
  ] as const)
    wrap(method, (args) => args[0] as MutationIdentity);
  for (const method of ["pullCurrentBranch", "fetch", "discardChanges"] as const)
    wrap(method, (args) => ({
      cwd: args[0] as string,
      executionTargetId: args[1] as string | undefined,
      operationId: args[2] as string | undefined,
    }));
  for (const method of ["prepareCommitContext", "pushCurrentBranch"] as const)
    wrap(method, (args) => ({
      cwd: args[0] as string,
      executionTargetId: args[2] as string | undefined,
      operationId: args[3] as string | undefined,
    }));
  wrap("commit", (args) => ({
    cwd: args[0] as string,
    ...(args[3] as Omit<MutationIdentity, "cwd">),
  }));
  return result;
}
