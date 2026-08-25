/**
 * Transport-neutral workspace discovery and content search.
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type {
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectSearchFileContentsInput,
  ProjectSearchFileContentsResult,
} from "@bigbud/contracts/workspace/project.ts";
import type {
  WorkspaceEntriesError,
  WorkspaceEntriesShape,
} from "../../workspace/Services/WorkspaceEntries.ts";
import type {
  WorkspaceFileSystemError,
  WorkspaceFileSystemShape,
} from "../../workspace/Services/WorkspaceFileSystem.ts";
import type { WorkspacePathOutsideRootError } from "../../workspace/Services/WorkspacePaths.ts";

export interface WorkspaceSearchShape {
  readonly searchEntries: (
    input: ProjectSearchEntriesInput,
  ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntriesError>;
  readonly searchFileContents: (
    input: ProjectSearchFileContentsInput,
  ) => Effect.Effect<
    ProjectSearchFileContentsResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;
}

export const workspaceSearchFromExistingServices = (input: {
  readonly fileSystem: WorkspaceFileSystemShape;
  readonly entries: WorkspaceEntriesShape;
}): WorkspaceSearchShape => ({
  searchEntries: input.entries.search,
  searchFileContents: input.fileSystem.searchFileContents,
});

export class WorkspaceSearch extends ServiceMap.Service<WorkspaceSearch, WorkspaceSearchShape>()(
  "bigbud/workspace-runtime/Services/WorkspaceSearch",
) {}
