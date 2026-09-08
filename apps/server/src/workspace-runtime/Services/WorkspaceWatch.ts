/**
 * Transport-neutral workspace invalidation hints.
 *
 * Watch streams are deliberately lossy. Consumers must rescan after a
 * resubscribe, generation change, or rescan-required event.
 */
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type {
  ProjectDirectoryWatchEvent,
  ProjectDirectoryWatchInput,
} from "@bigbud/contracts/workspace/project.ts";
import type { WorkspaceFileSystemError } from "../../workspace/Services/WorkspaceFileSystem.ts";
import type { WorkspacePathOutsideRootError } from "../../workspace/Services/WorkspacePaths.ts";

export interface WorkspaceWatchShape {
  readonly watchDirectory: (
    input: ProjectDirectoryWatchInput,
  ) => Effect.Effect<
    Stream.Stream<
      ProjectDirectoryWatchEvent,
      WorkspaceFileSystemError | WorkspacePathOutsideRootError
    >,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;
}

export const workspaceWatchFromExistingService = (input: {
  readonly watchDirectory: WorkspaceWatchShape["watchDirectory"];
}): WorkspaceWatchShape => ({
  watchDirectory: input.watchDirectory,
});

export class WorkspaceWatch extends ServiceMap.Service<WorkspaceWatch, WorkspaceWatchShape>()(
  "bigbud/workspace-runtime/Services/WorkspaceWatch",
) {}
