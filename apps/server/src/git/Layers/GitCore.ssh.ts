import { Effect } from "effect";

import { GitCommandError } from "@bigbud/contracts/workspace/git.errors.ts";

import { type ExecuteGitInput, type ExecuteGitResult } from "../Services/GitCore.ts";
import { type DirectWorkspaceGitOwner, executeOwnedWorkspaceGit } from "./GitCore.ssh.owner.ts";
import { quoteGitCommand } from "./GitCoreUtils.ts";

/**
 * Direct workspace Git for an SSH target. It runs only through a Rust owner
 * workspace-Git port; without one the command is refused typed and nothing is
 * launched (there is no TypeScript SSH executor).
 */
export function makeSshGitExecutor(owner?: DirectWorkspaceGitOwner) {
  return (input: ExecuteGitInput): Effect.Effect<ExecuteGitResult, GitCommandError> => {
    if (!input.executionTargetId) {
      return Effect.fail(
        new GitCommandError({
          operation: input.operation,
          command: quoteGitCommand(input.args),
          cwd: input.cwd,
          detail: "A remote Git execution target is required.",
        }),
      );
    }
    if (owner === undefined) {
      return Effect.fail(
        new GitCommandError({
          operation: input.operation,
          command: quoteGitCommand(input.args),
          cwd: input.cwd,
          detail:
            "Direct workspace Git over SSH is not available through the SSH owner yet. No Git command was launched.",
        }),
      );
    }
    return executeOwnedWorkspaceGit(owner, input, input.executionTargetId);
  };
}
