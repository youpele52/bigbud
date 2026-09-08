import { Effect, Layer } from "effect";

import { isLocalExecutionTarget } from "../executionTargets.ts";
import { WorkspaceFileSystem } from "../workspace/Services/WorkspaceFileSystem.ts";
import { WorkspacePaths } from "../workspace/Services/WorkspacePaths.ts";
import { WorkspaceWatch } from "../workspace-runtime/Services/WorkspaceWatch.ts";
import { LocalWorkspaceWatchAgent } from "./localWorkspaceWatchAgent.ts";
import { makeLocalWorkspaceWatch } from "./localWorkspaceWatch.ts";

export function makeLocalWorkspaceWatchLayer(
  makeAgent: () => LocalWorkspaceWatchAgent = () => new LocalWorkspaceWatchAgent(),
) {
  return Layer.effect(
    WorkspaceWatch,
    Effect.gen(function* () {
      const fileSystem = yield* WorkspaceFileSystem;
      const workspacePaths = yield* WorkspacePaths;
      const agent = yield* Effect.acquireRelease(Effect.sync(makeAgent), (agent) =>
        Effect.sync(() => agent.close()),
      );
      const local = makeLocalWorkspaceWatch(agent);
      return {
        watchDirectory: (input: Parameters<typeof local.watchDirectory>[0]) =>
          isLocalExecutionTarget(input.executionTargetId)
            ? Effect.gen(function* () {
                const cwd = yield* workspacePaths.normalizeWorkspaceRoot(input.cwd);
                const relativePath = input.relativePath
                  ? (yield* workspacePaths.resolveRelativePathWithinRoot({
                      workspaceRoot: cwd,
                      relativePath: input.relativePath,
                    })).relativePath
                  : "";
                return yield* local.watchDirectory({ ...input, cwd, relativePath });
              })
            : fileSystem.watchDirectory(input),
      };
    }),
  );
}
