/**
 * WorkspaceFileSystem - Effect service contract for workspace file mutations.
 *
 * Owns workspace-root-relative file write operations and their associated
 * safety checks and cache invalidation hooks.
 *
 * @module WorkspaceFileSystem
 */
import { Schema, ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type {
  ProjectDirectoryWatchEvent,
  ProjectDirectoryWatchInput,
  ProjectReadFilePreviewInput,
  ProjectReadFilePreviewResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@bigbud/contracts";
import { WorkspacePathOutsideRootError } from "./WorkspacePaths.ts";

export class WorkspaceFileSystemError extends Schema.TaggedErrorClass<WorkspaceFileSystemError>()(
  "WorkspaceFileSystemError",
  {
    cwd: Schema.String,
    relativePath: Schema.optional(Schema.String),
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/**
 * WorkspaceFileSystemShape - Service API for workspace-relative file operations.
 */
export interface WorkspaceFileSystemShape {
  /**
   * Read a bounded, text-only preview of a file relative to the workspace root.
   */
  readonly readFilePreview: (
    input: ProjectReadFilePreviewInput,
  ) => Effect.Effect<
    ProjectReadFilePreviewResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;

  /**
   * Write a file relative to the workspace root.
   *
   * Creates parent directories as needed and rejects paths that escape the
   * workspace root.
   */
  readonly writeFile: (
    input: ProjectWriteFileInput,
  ) => Effect.Effect<
    ProjectWriteFileResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;

  /**
   * Watch a directory relative to the workspace root and emit invalidation events.
   */
  readonly watchDirectory: (
    input: ProjectDirectoryWatchInput,
  ) => Effect.Effect<
    Stream.Stream<ProjectDirectoryWatchEvent, WorkspaceFileSystemError>,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;
}

/**
 * WorkspaceFileSystem - Service tag for workspace file operations.
 */
export class WorkspaceFileSystem extends ServiceMap.Service<
  WorkspaceFileSystem,
  WorkspaceFileSystemShape
>()("t3/workspace/Services/WorkspaceFileSystem") {}
