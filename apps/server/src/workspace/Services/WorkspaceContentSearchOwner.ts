import type {
  ProjectSearchFileContentsInput,
  ProjectSearchFileContentsResult,
} from "@bigbud/contracts/workspace/project.ts";
import { ServiceMap } from "effect";

/** Optional owner for direct SSH content search. Owner failures never trigger legacy search. */
export interface WorkspaceContentSearchOwnerShape {
  readonly searchFileContents: (
    input: ProjectSearchFileContentsInput & { executionTargetId: string },
  ) => Promise<ProjectSearchFileContentsResult>;
}

export class WorkspaceContentSearchOwner extends ServiceMap.Service<
  WorkspaceContentSearchOwner,
  WorkspaceContentSearchOwnerShape
>()("t3/workspace/Services/WorkspaceContentSearchOwner") {}
