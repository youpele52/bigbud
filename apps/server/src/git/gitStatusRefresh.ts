import { Effect } from "effect";

import { isLocalExecutionTarget } from "../executionTargets.ts";
import type { GitManagerShape } from "./Services/GitManager.ts";
import type { GitStatusBroadcasterShape } from "./Services/GitStatusBroadcaster.ts";
import type { RemoteGitStatusInvalidationShape } from "./Services/RemoteGitStatusInvalidation.ts";

export function makeGitStatusRefresh(input: {
  readonly gitManager: Pick<GitManagerShape, "invalidateStatus">;
  readonly gitStatusBroadcaster: Pick<
    GitStatusBroadcasterShape,
    "invalidateLocal" | "invalidateRemote"
  >;
  readonly remoteGitStatusInvalidation: RemoteGitStatusInvalidationShape;
}) {
  return (cwd: string, executionTargetId?: string) => {
    if (!executionTargetId || isLocalExecutionTarget(executionTargetId)) {
      return input.gitManager.invalidateStatus(cwd).pipe(
        Effect.flatMap(() => input.gitStatusBroadcaster.invalidateLocal(cwd)),
        Effect.flatMap(() => input.gitStatusBroadcaster.invalidateRemote(cwd)),
      );
    }
    return input.remoteGitStatusInvalidation.invalidate({ cwd, executionTargetId });
  };
}
