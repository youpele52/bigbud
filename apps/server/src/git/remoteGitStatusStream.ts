import { Effect, Option, Stream } from "effect";

import type {
  GitStatusLocalResult,
  GitStatusRemoteResult,
  GitStatusResult,
  GitStatusStreamEvent,
} from "@bigbud/contracts/workspace/git.results.ts";
import type { GitServiceError } from "@bigbud/contracts/workspace/git.errors.ts";
import type { GitCoreShape } from "./Services/GitCore.ts";
import type { RemoteGitStatusInvalidationShape } from "./Services/RemoteGitStatusInvalidation.ts";

const REMOTE_STATUS_POLL_INTERVAL = "2 seconds";

function toSnapshot(status: GitStatusResult): {
  readonly local: GitStatusLocalResult;
  readonly remote: GitStatusRemoteResult;
} {
  return {
    local: {
      isRepo: status.isRepo,
      ...(status.hostingProvider !== undefined ? { hostingProvider: status.hostingProvider } : {}),
      hasOriginRemote: status.hasOriginRemote,
      isDefaultBranch: status.isDefaultBranch,
      branch: status.branch,
      hasWorkingTreeChanges: status.hasWorkingTreeChanges,
      workingTree: status.workingTree,
    },
    remote: {
      hasUpstream: status.hasUpstream,
      aheadCount: status.aheadCount,
      behindCount: status.behindCount,
      pr: status.pr,
    },
  };
}

export function makeRemoteGitStatusStream(input: {
  readonly git: GitCoreShape;
  readonly cwd: string;
  readonly executionTargetId: string;
  readonly invalidation: RemoteGitStatusInvalidationShape;
}): Effect.Effect<Stream.Stream<GitStatusStreamEvent, never>, GitServiceError> {
  return Effect.gen(function* () {
    const initial = yield* input.git.status({
      cwd: input.cwd,
      executionTargetId: input.executionTargetId,
    });
    let previous = toSnapshot(initial);
    const snapshot: GitStatusStreamEvent = {
      _tag: "snapshot",
      local: previous.local,
      remote: previous.remote,
    };

    const refreshTriggers = Stream.merge(
      Stream.fromEffectRepeat(Effect.sleep(REMOTE_STATUS_POLL_INTERVAL)),
      input.invalidation.changes({
        cwd: input.cwd,
        executionTargetId: input.executionTargetId,
      }),
    );
    const updates = refreshTriggers.pipe(
      Stream.mapEffect(() =>
        input.git.status({ cwd: input.cwd, executionTargetId: input.executionTargetId }).pipe(
          Effect.map(toSnapshot),
          Effect.catch(() => Effect.succeed(null)),
        ),
      ),
      Stream.map((next) => {
        if (next === null) {
          return Option.none<GitStatusStreamEvent>();
        }

        const localChanged = JSON.stringify(next.local) !== JSON.stringify(previous.local);
        const remoteChanged = JSON.stringify(next.remote) !== JSON.stringify(previous.remote);
        previous = next;
        if (!localChanged && !remoteChanged) {
          return Option.none<GitStatusStreamEvent>();
        }
        if (localChanged && remoteChanged) {
          return Option.some<GitStatusStreamEvent>({
            _tag: "snapshot",
            local: next.local,
            remote: next.remote,
          });
        }
        return localChanged
          ? Option.some<GitStatusStreamEvent>({ _tag: "localUpdated", local: next.local })
          : Option.some<GitStatusStreamEvent>({ _tag: "remoteUpdated", remote: next.remote });
      }),
      Stream.filter((event) => Option.isSome(event)),
      Stream.map((event) => Option.getOrThrow(event)),
    );

    return Stream.concat(Stream.make(snapshot), updates);
  });
}
