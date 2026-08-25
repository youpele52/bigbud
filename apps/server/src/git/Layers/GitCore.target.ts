import { Effect } from "effect";

import { GitCommandError } from "@bigbud/contracts/workspace/git.errors.ts";
import { formatRemoteExecutionTargetDetail } from "../../executionTargets.ts";

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
