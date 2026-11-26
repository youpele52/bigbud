import type { ProjectReadFilePreviewResult } from "@bigbud/contracts/workspace/project.ts";
import { ServiceMap } from "effect";

import type { WorkspaceFileRangeResult } from "./WorkspaceFileSystem.ts";

interface WorkspaceFileReadOwnerInput {
  readonly executionTargetId: string;
  readonly cwd: string;
  readonly relativePath: string;
}

/** Optional owner for direct SSH reads; an owner failure must not trigger a legacy read. */
export interface WorkspaceFileReadOwnerShape {
  readonly readFilePreview: (
    input: WorkspaceFileReadOwnerInput,
  ) => Promise<Omit<ProjectReadFilePreviewResult, "relativePath">>;
  readonly readFileRange: (
    input: WorkspaceFileReadOwnerInput & { readonly offset: number; readonly maxBytes: number },
  ) => Promise<Omit<WorkspaceFileRangeResult, "relativePath">>;
}

export class WorkspaceFileReadOwner extends ServiceMap.Service<
  WorkspaceFileReadOwner,
  WorkspaceFileReadOwnerShape
>()("t3/workspace/Services/WorkspaceFileReadOwner") {}
