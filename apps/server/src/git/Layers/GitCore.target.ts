import { Effect } from "effect";

import { GitCommandError } from "@bigbud/contracts/workspace/git.errors.ts";
import {
  formatRemoteExecutionTargetDetail,
  isLocalExecutionTarget,
} from "../../executionTargets.ts";

export const assertLocalExecutionTarget = (
  operation: string,
  cwd: string,
  executionTargetId: string | null | undefined,
) =>
  isLocalExecutionTarget(executionTargetId)
    ? Effect.void
    : Effect.fail(
        new GitCommandError({
          operation,
          command: "execution-target",
          cwd,
          detail: formatRemoteExecutionTargetDetail({
            executionTargetId,
            surface: "Git execution",
          }),
        }),
      );

export function requireRemoteGitAgent(operation: string, cwd: string, executionTargetId: string) {
  return Effect.fail(
    new GitCommandError({
      operation,
      command: "execution-target",
      cwd,
      detail: formatRemoteExecutionTargetDetail({
        executionTargetId,
        surface: "Git execution",
      }),
    }),
  );
}
