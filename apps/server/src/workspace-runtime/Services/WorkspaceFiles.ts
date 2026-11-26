/**
 * Transport-neutral workspace file operations.
 *
 * This contract is intentionally narrower than WorkspaceFileSystem. Watches
 * remain a separate WorkspaceWatch capability because their lossy
 * replay and rescan semantics differ from bounded file reads.
 */
import { Effect, ServiceMap } from "effect";

import type {
  ProjectListDirectoryInput,
  ProjectListDirectoryResult,
  ProjectReadFilePreviewInput,
  ProjectReadFilePreviewResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@bigbud/contracts/workspace/project.ts";
import type {
  WorkspaceEntriesError,
  WorkspaceEntriesShape,
} from "../../workspace/Services/WorkspaceEntries.ts";
import type {
  WorkspaceFileSystemError,
  WorkspaceFileRangeInput,
  WorkspaceFileRangeResult,
  WorkspaceFileSystemShape,
} from "../../workspace/Services/WorkspaceFileSystem.ts";
import { localBackendFileEdit } from "../fileEditCapability.ts";
import type { WorkspacePathOutsideRootError } from "../../workspace/Services/WorkspacePaths.ts";

export interface WorkspaceFilesShape {
  readonly writeFile: (
    input: ProjectWriteFileInput,
  ) => Effect.Effect<
    ProjectWriteFileResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;
  readonly readFilePreview: (
    input: ProjectReadFilePreviewInput,
  ) => Effect.Effect<
    ProjectReadFilePreviewResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;
  readonly readFileRange: (
    input: WorkspaceFileRangeInput,
  ) => Effect.Effect<
    WorkspaceFileRangeResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;
  readonly listDirectory: (
    input: ProjectListDirectoryInput,
  ) => Effect.Effect<ProjectListDirectoryResult, WorkspaceEntriesError>;
}

export const workspaceFilesFromExistingServices = (input: {
  readonly fileSystem: WorkspaceFileSystemShape;
  readonly entries: WorkspaceEntriesShape;
}): WorkspaceFilesShape => ({
  writeFile: input.fileSystem.writeFile,
  readFilePreview: (value) =>
    input.fileSystem
      .readFilePreview(value)
      .pipe(
        Effect.map((result) =>
          Object.assign({}, result, { edit: localBackendFileEdit(value.executionTargetId) }),
        ),
      ),
  readFileRange: input.fileSystem.readFileRange,
  listDirectory: input.entries.listDirectory,
});

export class WorkspaceFiles extends ServiceMap.Service<WorkspaceFiles, WorkspaceFilesShape>()(
  "bigbud/workspace-runtime/Services/WorkspaceFiles",
) {}
