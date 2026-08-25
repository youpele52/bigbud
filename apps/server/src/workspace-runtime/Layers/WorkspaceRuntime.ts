import { Effect, FileSystem, Layer, Path } from "effect";

import { WorkspaceEntriesLive } from "../../workspace/Layers/WorkspaceEntries.ts";
import { WorkspaceFileSystemLive } from "../../workspace/Layers/WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "../../workspace/Layers/WorkspacePaths.ts";
import { WorkspaceEntries } from "../../workspace/Services/WorkspaceEntries.ts";
import { WorkspaceFileSystem } from "../../workspace/Services/WorkspaceFileSystem.ts";
import { WorkspacePaths } from "../../workspace/Services/WorkspacePaths.ts";
import { WorkspaceFiles, workspaceFilesFromExistingServices } from "../Services/WorkspaceFiles.ts";
import { WorkspaceRuntime } from "../Services/WorkspaceRuntime.ts";
import {
  RemoteWorkspaceRuntime,
  type WorkspaceRuntimeBackendShape,
} from "../Services/WorkspaceRuntime.ts";
import {
  WorkspaceSearch,
  workspaceSearchFromExistingServices,
} from "../Services/WorkspaceSearch.ts";
import { WorkspaceWatch } from "../Services/WorkspaceWatch.ts";
import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { makeLocalWorkspaceWatchLayer } from "../../remote-agent/localWorkspaceWatchLayer.ts";

export function makeTargetAwareRuntime(input: {
  readonly local: WorkspaceRuntimeBackendShape;
  readonly remote?: WorkspaceRuntimeBackendShape;
}): WorkspaceRuntimeBackendShape {
  const backend = (executionTargetId: string | undefined) =>
    input.remote && !isLocalExecutionTarget(executionTargetId) ? input.remote : input.local;
  return {
    files: {
      writeFile: (value) => backend(value.executionTargetId).files.writeFile(value),
      readFilePreview: (value) => backend(value.executionTargetId).files.readFilePreview(value),
      readFileRange: (value) => backend(value.executionTargetId).files.readFileRange(value),
      listDirectory: (value) => backend(value.executionTargetId).files.listDirectory(value),
    },
    search: {
      searchEntries: (value) => backend(value.executionTargetId).search.searchEntries(value),
      searchFileContents: (value) =>
        backend(value.executionTargetId).search.searchFileContents(value),
    },
    watch: {
      watchDirectory: (value) => backend(value.executionTargetId).watch.watchDirectory(value),
    },
  };
}

const workspaceEntriesForRuntimeLive = WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive));
const workspaceFileSystemForRuntimeLive = WorkspaceFileSystemLive.pipe(
  Layer.provide(WorkspacePathsLive),
  Layer.provide(workspaceEntriesForRuntimeLive),
);
const workspaceFilesLive = Layer.effect(
  WorkspaceFiles,
  Effect.gen(function* () {
    const fileSystem = yield* WorkspaceFileSystem;
    const entries = yield* WorkspaceEntries;
    return workspaceFilesFromExistingServices({ fileSystem, entries });
  }),
).pipe(
  Layer.provide(workspaceFileSystemForRuntimeLive),
  Layer.provide(workspaceEntriesForRuntimeLive),
);
const workspaceSearchLive = Layer.effect(
  WorkspaceSearch,
  Effect.gen(function* () {
    const fileSystem = yield* WorkspaceFileSystem;
    const entries = yield* WorkspaceEntries;
    return workspaceSearchFromExistingServices({ fileSystem, entries });
  }),
).pipe(
  Layer.provide(workspaceFileSystemForRuntimeLive),
  Layer.provide(workspaceEntriesForRuntimeLive),
);
const makeWorkspaceRuntimeLive = (
  localWatchLayer: Layer.Layer<WorkspaceWatch, never, FileSystem.FileSystem | Path.Path>,
) =>
  Layer.effect(
    WorkspaceRuntime,
    Effect.gen(function* () {
      const files = yield* WorkspaceFiles;
      const search = yield* WorkspaceSearch;
      const watch = yield* WorkspaceWatch;
      const remote = yield* Effect.serviceOption(RemoteWorkspaceRuntime);
      return makeTargetAwareRuntime({
        local: { files, search, watch },
        ...(remote._tag === "Some" ? { remote: remote.value } : {}),
      });
    }),
  ).pipe(
    Layer.provide(workspaceFilesLive),
    Layer.provide(workspaceSearchLive),
    Layer.provide(localWatchLayer),
  );

/**
 * Complete workspace runtime composition. Existing workspace services are
 * kept in the output so current callers and the new façade can coexist during
 * the migration. A remote backend is opt-in and only selected for remote
 * execution targets.
 */
export function makeWorkspaceRuntimeLayer(
  remoteLayer?: Layer.Layer<RemoteWorkspaceRuntime>,
  localWatchLayer: Layer.Layer<
    WorkspaceWatch,
    never,
    WorkspaceFileSystem | WorkspacePaths
  > = makeLocalWorkspaceWatchLayer(),
) {
  const resolvedLocalWatchLayer = localWatchLayer.pipe(
    Layer.provide(workspaceFileSystemForRuntimeLive),
    Layer.provide(WorkspacePathsLive),
  );
  const workspaceRuntimeLive = makeWorkspaceRuntimeLive(resolvedLocalWatchLayer);
  const runtime = remoteLayer
    ? workspaceRuntimeLive.pipe(Layer.provide(remoteLayer))
    : workspaceRuntimeLive;
  return Layer.mergeAll(
    WorkspacePathsLive,
    workspaceEntriesForRuntimeLive,
    workspaceFileSystemForRuntimeLive,
    workspaceFilesLive,
    workspaceSearchLive,
    resolvedLocalWatchLayer,
    runtime,
  );
}

export const WorkspaceRuntimeLayerLive = makeWorkspaceRuntimeLayer();
